/**
 * Client-side members-room body encryption (`DESIGN-rooms.md` §7.4).
 *
 * The contract treats `body` as opaque bytes. The UI encrypts the composer text
 * with the epoch key (recovered from the owner-signed `secrets` through the
 * delegate) and stores the envelope as lowercase hex. Decryption is purely
 * local: the transport never sees plaintext bodies.
 *
 * Envelope: `0x01 || nonce(12) || ciphertext || tag(16)`.
 * AAD:      `"number:v1:room:body" || "ZMR1" || roomId32 || owner32 ||
 *            author32 || epoch_le(8)`.
 *
 * The first byte is fail-closed: anything else is legacy plaintext. A `0x01`
 * body that does not authenticate is "unreadable", never plaintext.
 */

import bs58 from "bs58";
import { ROOM_MAX_BODY_BYTES, roomBodyToText } from "./room-state";
import { bytesToHex, hexToBytes, isLowerHex } from "./util";

/** The only members-room tag. */
export const ROOM_CRYPTO_TAG = "ZMR1";
/** Body domain separator. */
export const ROOM_BODY_DOMAIN = "number:v1:room:body";
/** Body envelope version byte. */
export const ROOM_BODY_VERSION = 0x01;
/** AES-GCM nonce length. */
export const ROOM_BODY_NONCE_BYTES = 12;
/** AES-GCM tag length. */
export const ROOM_BODY_TAG_BYTES = 16;
/** Fixed envelope overhead: version + nonce + tag. */
export const ROOM_BODY_OVERHEAD = 1 + ROOM_BODY_NONCE_BYTES + ROOM_BODY_TAG_BYTES;

/**
 * Largest plaintext the composer accepts in an encrypted epoch: the contract
 * cap (1024) minus the envelope overhead (29).
 */
export const ROOM_ENCRYPTED_BODY_BYTE_LIMIT =
  ROOM_MAX_BODY_BYTES - ROOM_BODY_OVERHEAD;
/** Legacy plaintext cap (the contract body cap). */
export const ROOM_LEGACY_BODY_BYTE_LIMIT = ROOM_MAX_BODY_BYTES;

/** A malformed envelope or a failed authentication. Never includes plaintext. */
export class RoomCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomCryptoError";
  }
}

/** The three render states a stored body can produce. */
export type RoomBodyView =
  | { kind: "plaintext"; text: string }
  | { kind: "encrypted"; text: string }
  | { kind: "unreadable" };

/** Context bound into the body AAD. */
export interface RoomBodyContext {
  /** Base58 room instance id (32 decoded bytes). */
  roomId: string;
  /** Room owner, 64 lowercase hex characters. */
  owner: string;
  /** Message author, 64 lowercase hex characters. */
  author: string;
  /** Membership epoch / seq, a positive safe integer. */
  epoch: number;
  /**
   * Room-kind tag bound into the AAD. Defaults to the members-room tag
   * (`ZMR1`); the candidate client passes `ZCR1`.
   */
  tag?: string;
}

const encoder = new TextEncoder();

/** Browser WebCrypto; injectable so tests can supply a fake. */
export function defaultRoomSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new RoomCryptoError("WebCrypto is not available in this environment.");
  }
  return subtle;
}

function assertEpochKey(epochKey: Uint8Array): Uint8Array {
  if (!(epochKey instanceof Uint8Array) || epochKey.length !== 32) {
    throw new RoomCryptoError("Room epoch keys are 32 bytes.");
  }
  return new Uint8Array(epochKey);
}

/** Validate a 32-byte lowercase-hex epoch key from the delegate. */
export function epochKeyFromHex(hex: string): Uint8Array {
  if (!isLowerHex(hex, 64)) {
    throw new RoomCryptoError(
      "Room epoch key must be 64 lowercase hex characters.",
    );
  }
  return hexToBytes(hex);
}

/** Lowercase-hex form of a 32-byte epoch key. */
export function epochKeyToHex(key: Uint8Array): string {
  return bytesToHex(assertEpochKey(key));
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

function epochLe(epoch: number): Uint8Array {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new RoomCryptoError("Room epoch must be a positive safe integer.");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(epoch), true);
  return bytes;
}

/** WebCrypto's DOM types require an ArrayBuffer-backed view. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function ownerBytes(value: string, field: string): Uint8Array {
  if (!isLowerHex(value, 64)) {
    throw new RoomCryptoError(
      `Room ${field} must be 64 lowercase hex characters.`,
    );
  }
  return hexToBytes(value);
}

function roomIdBytes(roomId: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(roomId);
  } catch {
    throw new RoomCryptoError("Room id is not valid base58.");
  }
  if (bytes.length !== 32) {
    throw new RoomCryptoError("Room id must decode to 32 bytes.");
  }
  return bytes;
}

/** `"number:v1:room:body" || tag || roomId || owner || author || epoch_le`. */
export function roomBodyAad(context: RoomBodyContext): Uint8Array {
  return concat([
    encoder.encode(ROOM_BODY_DOMAIN),
    encoder.encode(context.tag ?? ROOM_CRYPTO_TAG),
    roomIdBytes(context.roomId),
    ownerBytes(context.owner, "owner"),
    ownerBytes(context.author, "author"),
    epochLe(context.epoch),
  ]);
}

/** True when the first decoded byte is the `0x01` envelope version. */
export function isEncryptedRoomBody(bodyHex: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(bodyHex);
  } catch {
    return false;
  }
  return bytes.length > 0 && bytes[0] === ROOM_BODY_VERSION;
}

/**
 * Encrypt composer text. Returns the exact envelope bytes. The 995-byte
 * plaintext cap is enforced here as well as in the composer, so no caller can
 * produce an over-cap body.
 */
export async function encryptRoomBody(
  epochKey: Uint8Array,
  context: RoomBodyContext,
  text: string,
  subtle: SubtleCrypto = defaultRoomSubtle(),
): Promise<Uint8Array> {
  const keyBytes = assertEpochKey(epochKey);
  const plaintext = encoder.encode(text);
  if (plaintext.length < 1) {
    throw new RoomCryptoError("Room message body must not be empty.");
  }
  if (plaintext.length > ROOM_ENCRYPTED_BODY_BYTE_LIMIT) {
    throw new RoomCryptoError(
      `Encrypted room messages are limited to ${ROOM_ENCRYPTED_BODY_BYTE_LIMIT} bytes.`,
    );
  }

  const nonce = new Uint8Array(ROOM_BODY_NONCE_BYTES);
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new RoomCryptoError("WebCrypto random values are unavailable.");
  }
  webCrypto.getRandomValues(nonce);

  const key = await subtle.importKey("raw", bufferOf(keyBytes), "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: bufferOf(nonce),
        additionalData: bufferOf(roomBodyAad(context)),
        tagLength: 128,
      },
      key,
      bufferOf(plaintext),
    ),
  );
  return concat([Uint8Array.of(ROOM_BODY_VERSION), nonce, sealed]);
}

/**
 * Decrypt a `0x01` envelope. Throws `RoomCryptoError` on a version mismatch,
 * a short envelope, a tampered ciphertext/tag, or a wrong AAD context.
 */
export async function decryptRoomBody(
  epochKey: Uint8Array,
  context: RoomBodyContext,
  bodyHex: string,
  subtle: SubtleCrypto = defaultRoomSubtle(),
): Promise<string> {
  const keyBytes = assertEpochKey(epochKey);
  let envelope: Uint8Array;
  try {
    envelope = hexToBytes(bodyHex);
  } catch {
    throw new RoomCryptoError("Room body is not valid hex.");
  }
  if (envelope.length < ROOM_BODY_OVERHEAD) {
    throw new RoomCryptoError("Room body is too short to be encrypted.");
  }
  if (envelope[0] !== ROOM_BODY_VERSION) {
    throw new RoomCryptoError("Room body is legacy plaintext, not encrypted.");
  }

  const nonce = envelope.slice(1, 1 + ROOM_BODY_NONCE_BYTES);
  const sealed = envelope.slice(1 + ROOM_BODY_NONCE_BYTES);
  const key = await subtle.importKey("raw", bufferOf(keyBytes), "AES-GCM", false, [
    "decrypt",
  ]);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bufferOf(nonce),
        additionalData: bufferOf(roomBodyAad(context)),
        tagLength: 128,
      },
      key,
      bufferOf(sealed),
    );
  } catch {
    // Deliberately opaque: never leak ciphertext or a partial plaintext.
    throw new RoomCryptoError("Room body could not be decrypted.");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(plaintext);
}

/**
 * Panel-facing read: legacy bodies decode as plaintext, encrypted bodies that
 * cannot be opened are `unreadable` and never fall back to plaintext.
 */
export async function readRoomBody(
  epochKey: Uint8Array | null,
  context: RoomBodyContext,
  bodyHex: string,
  subtle: SubtleCrypto = defaultRoomSubtle(),
): Promise<RoomBodyView> {
  if (!isEncryptedRoomBody(bodyHex)) {
    try {
      return { kind: "plaintext", text: roomBodyToText(bodyHex) };
    } catch {
      return { kind: "unreadable" };
    }
  }
  if (epochKey === null) return { kind: "unreadable" };
  try {
    return {
      kind: "encrypted",
      text: await decryptRoomBody(epochKey, context, bodyHex, subtle),
    };
  } catch {
    return { kind: "unreadable" };
  }
}

function cacheKey(roomId: string, epoch: number): string {
  return `${roomId}\u0000${epoch}`;
}

/**
 * In-memory epoch-key cache, keyed `(roomId, epoch)`.
 *
 * Keys live for the session only. The panel clears this on room close and on
 * an identity switch; nothing here is persisted or exported.
 */
export class RoomEpochKeyCache {
  private readonly keys = new Map<string, Uint8Array>();

  set(roomId: string, epoch: number, key: Uint8Array): void {
    this.keys.set(cacheKey(roomId, epoch), assertEpochKey(key));
  }

  /** A copy, so callers cannot mutate the cached key. */
  get(roomId: string, epoch: number): Uint8Array | null {
    const key = this.keys.get(cacheKey(roomId, epoch));
    return key === undefined ? null : new Uint8Array(key);
  }

  has(roomId: string, epoch: number): boolean {
    return this.keys.has(cacheKey(roomId, epoch));
  }

  deleteRoom(roomId: string): void {
    const prefix = `${roomId}\u0000`;
    for (const key of [...this.keys.keys()]) {
      if (key.startsWith(prefix)) this.keys.delete(key);
    }
  }

  clear(): void {
    this.keys.clear();
  }
}

/** Process-wide cache used by the transport and panel. */
export const roomEpochKeyCache = new RoomEpochKeyCache();
