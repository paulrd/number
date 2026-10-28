import { describe, expect, it } from "vitest";
import {
  IdentityBackupError,
  decodeIdentityBackup,
  encodeIdentityBackup,
  identityBackupFilename,
} from "./identity";

const SEED = "ab".repeat(32);
const PUBKEY = "7193df714c57b79be0fb550f3150ccb0a23680dd2ccc305cef87a712c244e351";
const NEXT_SEQ = [1, 2, 3, 4, 5, 6, 7, 8];

function backup(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    kind: "number-identity",
    seed: SEED,
    nextSeq: NEXT_SEQ,
    contactsNextSeq: 2,
    pubkey: PUBKEY,
    createdAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  });
}

describe("identity backup codec", () => {
  it("round-trips seed, counters and public key", () => {
    const text = encodeIdentityBackup(
      {
        seed: SEED.toUpperCase(),
        nextSeq: NEXT_SEQ,
        contactsNextSeq: 3,
        parentNextSeq: 4,
      },
      PUBKEY,
      new Date("2026-10-27T12:00:00.000Z"),
    );
    expect(decodeIdentityBackup(text)).toEqual({
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 3,
      parentNextSeq: 4,
      pubkey: PUBKEY,
    });
    const parsed = JSON.parse(text);
    expect(parsed.contactsNextSeq).toBe(3);
    expect(parsed.parentNextSeq).toBe(4);
    expect(parsed.createdAt).toBe("2026-10-27T12:00:00.000Z");
  });

  it("accepts a code without the informational fields", () => {
    expect(
      decodeIdentityBackup(backup({ pubkey: undefined, createdAt: undefined })),
    ).toEqual({
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 2,
      parentNextSeq: 1,
    });
  });

  it("accepts a v1 backup with no contacts counter and defaults it to 1", () => {
    const legacy = backup({ contactsNextSeq: undefined });
    expect(legacy).not.toContain("contactsNextSeq");
    expect(decodeIdentityBackup(legacy)).toEqual({
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 1,
      parentNextSeq: 1,
      pubkey: PUBKEY,
    });
  });

  it("trims surrounding whitespace from a pasted code", () => {
    expect(decodeIdentityBackup(`\n  ${backup()}  \n`).seed).toBe(SEED);
  });

  it("rejects empty input, non-JSON, and the wrong envelope", () => {
    for (const value of ["", "   ", "not json", "[]", "null", '"x"']) {
      expect(() => decodeIdentityBackup(value)).toThrow(IdentityBackupError);
    }
    expect(() => decodeIdentityBackup(backup({ kind: "other" }))).toThrow(
      /not a version 1 number identity backup/,
    );
    expect(() => decodeIdentityBackup(backup({ v: 2 }))).toThrow(
      /not a version 1 number identity backup/,
    );
  });

  it("rejects a malformed seed", () => {
    for (const seed of [SEED.slice(0, 62), "zz".repeat(32), 42, undefined]) {
      expect(() => decodeIdentityBackup(backup({ seed }))).toThrow(
        /seed must be 32 bytes of hex/,
      );
    }
  });

  it("rejects a malformed sequence list", () => {
    for (const nextSeq of [
      [1, 2, 3],
      [1, 2, 3, 4, 5, 6, 7, 0],
      [1, 2, 3, 4, 5, 6, 7, -1],
      [1, 2, 3, 4, 5, 6, 7, 1.5],
      [1, 2, 3, 4, 5, 6, 7, "8"],
      undefined,
    ]) {
      expect(() => decodeIdentityBackup(backup({ nextSeq }))).toThrow(
        /sequence list must contain 8 positive integers/,
      );
    }
  });

  it("rejects a malformed contacts counter", () => {
    for (const contactsNextSeq of [0, -1, 1.5, "2", true]) {
      expect(() => decodeIdentityBackup(backup({ contactsNextSeq }))).toThrow(
        /contacts sequence must be a positive integer/,
      );
    }
  });

  it("defaults a missing parent counter to 1 (pre-tree backup)", () => {
    const legacy = backup({ parentNextSeq: undefined });
    expect(legacy).not.toContain("parentNextSeq");
    expect(decodeIdentityBackup(legacy).parentNextSeq).toBe(1);
  });

  it("round-trips an explicit parent counter", () => {
    const text = backup({ parentNextSeq: 9 });
    expect(decodeIdentityBackup(text).parentNextSeq).toBe(9);
  });

  it("rejects a malformed parent counter", () => {
    for (const parentNextSeq of [0, -1, 1.5, "2", true, null]) {
      expect(() => decodeIdentityBackup(backup({ parentNextSeq }))).toThrow(
        /parent sequence must be a positive integer/,
      );
    }
  });

  it("rejects a malformed public key", () => {
    for (const pubkey of ["abc", "zz".repeat(32), 7]) {
      expect(() => decodeIdentityBackup(backup({ pubkey }))).toThrow(
        /public key must be 64 hex characters/,
      );
    }
  });

  it("names downloaded backups by public key when known", () => {
    expect(identityBackupFilename(PUBKEY)).toBe(
      "number-identity-7193df71.json",
    );
    expect(identityBackupFilename()).toBe("number-identity.json");
  });
});
