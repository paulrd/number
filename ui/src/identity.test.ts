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
const CONTACT_A = "11".repeat(32);
const CONTACT_B = "22".repeat(32);

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
        payloadVersion: 2,
        seed: SEED.toUpperCase(),
        nextSeq: NEXT_SEQ,
        contactsNextSeq: 3,
        parentNextSeq: 4,
        contacts: [
          { label: "Alice", userId: CONTACT_A, address: null },
          { label: "Bob", userId: CONTACT_B, address: "52" },
        ],
      },
      PUBKEY,
      new Date("2026-10-27T12:00:00.000Z"),
    );
    expect(decodeIdentityBackup(text)).toEqual({
      payloadVersion: 2,
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 3,
      parentNextSeq: 4,
      paymentsNextSeq: 1,
      adjustmentsNextSeq: 1,
      childNamesNextSeq: 1,
      selfNameNextSeq: 1,
      contacts: [
        { label: "Alice", userId: CONTACT_A, address: null },
        { label: "Bob", userId: CONTACT_B, address: "52" },
      ],
      pubkey: PUBKEY,
    });
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(2);
    expect(parsed.payloadVersion).toBe(2);
    expect(parsed.contactsNextSeq).toBe(3);
    expect(parsed.parentNextSeq).toBe(4);
    expect(parsed.paymentsNextSeq).toBe(1);
    expect(parsed.contacts).toHaveLength(2);
    expect(parsed.createdAt).toBe("2026-10-27T12:00:00.000Z");
  });

  it("round-trips an explicit payments counter", () => {
    const text = encodeIdentityBackup(
      {
        payloadVersion: 2,
        seed: SEED,
        nextSeq: NEXT_SEQ,
        contactsNextSeq: 3,
        parentNextSeq: 4,
        paymentsNextSeq: 12,
        childNamesNextSeq: 5,
        selfNameNextSeq: 6,
        contacts: [],
      },
      PUBKEY,
      new Date("2026-10-27T12:00:00.000Z"),
    );
    expect(decodeIdentityBackup(text).paymentsNextSeq).toBe(12);
  });

  it("accepts a code without the informational fields", () => {
    expect(
      decodeIdentityBackup(backup({ pubkey: undefined, createdAt: undefined })),
    ).toEqual({
      payloadVersion: 1,
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 2,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      adjustmentsNextSeq: 1,
      childNamesNextSeq: 1,
      selfNameNextSeq: 1,
      contacts: [],
    });
  });

  it("accepts a v1 backup with no contacts counter and defaults it to 1", () => {
    const legacy = backup({ contactsNextSeq: undefined });
    expect(legacy).not.toContain("contactsNextSeq");
    expect(decodeIdentityBackup(legacy)).toEqual({
      payloadVersion: 1,
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      adjustmentsNextSeq: 1,
      childNamesNextSeq: 1,
      selfNameNextSeq: 1,
      contacts: [],
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
      /not a number identity backup/,
    );
    expect(() => decodeIdentityBackup(backup({ v: 3 }))).toThrow(
      /not a number identity backup/,
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

  it("defaults a missing payments counter to 1 (pre-payments backup)", () => {
    const legacy = backup({ paymentsNextSeq: undefined });
    expect(legacy).not.toContain("paymentsNextSeq");
    expect(decodeIdentityBackup(legacy).paymentsNextSeq).toBe(1);
  });

  it("decodes an explicit payments counter", () => {
    expect(decodeIdentityBackup(backup({ paymentsNextSeq: 11 })).paymentsNextSeq).toBe(
      11,
    );
  });

  it("rejects a malformed payments counter", () => {
    for (const paymentsNextSeq of [0, -1, 1.5, "2", true, null]) {
      expect(() => decodeIdentityBackup(backup({ paymentsNextSeq }))).toThrow(
        /payments sequence must be a positive integer/,
      );
    }
  });

  it("round-trips the adjustments counter so a restore cannot reuse a seq", () => {
    const text = encodeIdentityBackup(
      {
        payloadVersion: 2,
        seed: SEED,
        nextSeq: NEXT_SEQ,
        contactsNextSeq: 3,
        parentNextSeq: 4,
        paymentsNextSeq: 5,
        adjustmentsNextSeq: 8,
        childNamesNextSeq: 6,
        selfNameNextSeq: 7,
        contacts: [],
      },
      PUBKEY,
      new Date("2026-10-27T12:00:00.000Z"),
    );
    expect(JSON.parse(text).adjustmentsNextSeq).toBe(8);
    expect(decodeIdentityBackup(text).adjustmentsNextSeq).toBe(8);
  });

  it("defaults a missing adjustments counter to 1 (pre-issue/burn backup)", () => {
    const legacy = backup({ adjustmentsNextSeq: undefined });
    expect(legacy).not.toContain("adjustmentsNextSeq");
    expect(decodeIdentityBackup(legacy).adjustmentsNextSeq).toBe(1);
  });

  it("rejects a malformed adjustments counter", () => {
    for (const adjustmentsNextSeq of [0, -1, 1.5, "2", true, null]) {
      expect(() => decodeIdentityBackup(backup({ adjustmentsNextSeq }))).toThrow(
        /adjustments sequence must be a positive integer/,
      );
    }
  });

  it("decodes a v2 backup with contacts and name counters", () => {
    const decoded = decodeIdentityBackup(
      JSON.stringify({
        v: 2,
        kind: "number-identity",
        payloadVersion: 2,
        seed: SEED,
        nextSeq: NEXT_SEQ,
        contactsNextSeq: 3,
        parentNextSeq: 4,
        paymentsNextSeq: 5,
        childNamesNextSeq: 6,
        selfNameNextSeq: 7,
        contacts: [
          { label: "Alice", userId: CONTACT_A, address: null },
          { label: "Bob", userId: CONTACT_B, address: "52" },
        ],
      }),
    );
    expect(decoded).toEqual({
      payloadVersion: 2,
      seed: SEED,
      nextSeq: NEXT_SEQ,
      contactsNextSeq: 3,
      parentNextSeq: 4,
      paymentsNextSeq: 5,
      adjustmentsNextSeq: 1,
      childNamesNextSeq: 6,
      selfNameNextSeq: 7,
      contacts: [
        { label: "Alice", userId: CONTACT_A, address: null },
        { label: "Bob", userId: CONTACT_B, address: "52" },
      ],
    });
  });

  it("rejects malformed v2 contacts and payload versions", () => {
    const withContacts = (contacts: unknown) =>
      JSON.stringify({
        v: 2,
        kind: "number-identity",
        payloadVersion: 2,
        seed: SEED,
        nextSeq: NEXT_SEQ,
        contacts,
      });
    for (const contacts of [
      "nope",
      [{ label: "", userId: CONTACT_A }],
      [{ label: "Alice", userId: "AB".repeat(32) }],
      [{ label: "Alice", userId: CONTACT_A, address: "58" }],
      [
        { label: "Alice", userId: CONTACT_A },
        { label: "Bob", userId: CONTACT_A },
      ],
      [
        { label: "Alice", userId: CONTACT_A },
        { label: "Alice", userId: CONTACT_B },
      ],
    ]) {
      expect(
        () => decodeIdentityBackup(withContacts(contacts)),
        JSON.stringify(contacts),
      ).toThrow(IdentityBackupError);
    }
    expect(() =>
      decodeIdentityBackup(
        JSON.stringify({
          v: 2,
          kind: "number-identity",
          payloadVersion: 3,
          seed: SEED,
          nextSeq: NEXT_SEQ,
        }),
      ),
    ).toThrow(/payload version must be 1 or 2/);
  });

  it("defaults missing v6 name counters to 1", () => {
    expect(decodeIdentityBackup(backup())).toMatchObject({
      childNamesNextSeq: 1,
      selfNameNextSeq: 1,
      contacts: [],
    });
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
