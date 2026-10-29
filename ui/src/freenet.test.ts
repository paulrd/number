import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import * as flatbuffers from "flatbuffers";
import { describe, expect, it } from "vitest";
import {
  buildNumberPutRequest,
  decodeCodeHash,
  deriveContractKey,
  deriveContractKeyTFromParts,
  deriveInstanceId,
  deriveInstanceIdFromBytes,
  encodeBase58,
} from "./freenet";
import { emptyState, encodeState } from "./state";
import { LEGACY_CONTRACT_CODE_HASHES } from "./migrations";
import { bytesToHex } from "./util";

// Fixed 32-byte inputs. The instance-id formula is pinned twice: a hard-coded
// golden value and an independent @noble/hashes computation in this test.
const CODE_HASH_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);
const PARAMETERS = Uint8Array.from({ length: 32 }, (_, index) => 32 + index);
const CODE_HASH_BASE58 = "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE";
const EXPECTED_INSTANCE_HEX =
  "4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98";
const EXPECTED_INSTANCE_BASE58 = "6K6o9jHGQADAQTd1PyK7qBEfkiktjtVssjxNUmEWELeK";

describe("contract key derivation", () => {
  it("matches the golden vector for BLAKE3(code_hash || parameters)", () => {
    const instance = deriveInstanceIdFromBytes(CODE_HASH_BYTES, PARAMETERS);

    expect(bytesToHex(instance.bytes)).toBe(EXPECTED_INSTANCE_HEX);
    expect(instance.base58).toBe(EXPECTED_INSTANCE_BASE58);

    // Independent construction of the preimage in the test only.
    const preimage = new Uint8Array(64);
    preimage.set(CODE_HASH_BYTES, 0);
    preimage.set(PARAMETERS, 32);
    expect(bytesToHex(instance.bytes)).toBe(bytesToHex(blake3(preimage)));

    expect(encodeBase58(CODE_HASH_BYTES)).toBe(CODE_HASH_BASE58);
    expect(bytesToHex(decodeCodeHash(CODE_HASH_BASE58))).toBe(
      bytesToHex(CODE_HASH_BYTES),
    );
  });

  it("base58 and byte entry points agree", () => {
    const fromBytes = deriveInstanceIdFromBytes(CODE_HASH_BYTES, PARAMETERS);
    const fromBase58 = deriveInstanceId(CODE_HASH_BASE58, PARAMETERS);
    expect(fromBase58.bytes).toEqual(fromBytes.bytes);
    expect(fromBase58.base58).toBe(EXPECTED_INSTANCE_BASE58);
  });

  it("builds the reader key with the instance and code hash kept separate", () => {
    const key = deriveContractKey(CODE_HASH_BASE58, PARAMETERS);
    expect(key.encode()).toBe(EXPECTED_INSTANCE_BASE58);
    const codePart = key.codePart();
    expect(codePart).not.toBeNull();
    expect(bytesToHex(codePart ?? new Uint8Array())).toBe(
      bytesToHex(CODE_HASH_BYTES),
    );
  });

  it("builds the packable key PUT requires", () => {
    const key = deriveContractKeyTFromParts(CODE_HASH_BYTES, PARAMETERS);
    const instance = deriveInstanceIdFromBytes(CODE_HASH_BYTES, PARAMETERS);
    expect(key.instance?.data).toEqual(Array.from(instance.bytes));
    expect(key.code).toEqual(Array.from(CODE_HASH_BYTES));
  });

  it("serializes the PUT container (reader keys / missing related contracts throw here)", () => {
    const request = buildNumberPutRequest(
      new Uint8Array([0, 97, 115, 109]),
      CODE_HASH_BYTES,
      PARAMETERS,
      encodeState(emptyState()),
    );
    const builder = new flatbuffers.Builder(0);
    expect(() => {
      const offset = request.pack(builder);
      builder.finish(offset);
    }).not.toThrow();
  });

  it("resolves a stale code hash to a different instance id", () => {
    // A delegate configured with an old hash looks at a different instance for
    // the same owner, which is why a stale hash silently finds no neighbours.
    const active = deriveInstanceId(CODE_HASH_BASE58, PARAMETERS);
    const stale = deriveInstanceId(LEGACY_CONTRACT_CODE_HASHES[0], PARAMETERS);
    expect(stale.base58).not.toBe(active.base58);
    expect(stale.bytes).not.toEqual(active.bytes);
  });

  it("rejects code hashes that are not 32 bytes", () => {
    const short = bs58.encode(CODE_HASH_BYTES.slice(0, 31));
    expect(() => decodeCodeHash(short)).toThrow(/32 bytes/);
    expect(() => deriveInstanceId("not base58 !!!", PARAMETERS)).toThrow(
      /base58|32 bytes/,
    );
  });
});
