/**
 * Admission codes: the portable credential that replaces a cross-node zone read.
 *
 * Signatures in these tests are real Ed25519 signatures over the canonical slot
 * bytes (`state.ts` mirrors the contract's `signing_bytes`).
 */

import * as ed from "@noble/ed25519";
import { describe, expect, it } from "vitest";

import {
  ADMISSION_CODE_PREFIX,
  admissionCodeAddress,
  admissionCodeFromInput,
  admissionFailureText,
  buildAdmissionCode,
  crossCheckAdmission,
  decodeAdmissionCode,
  encodeAdmissionCode,
  verifyAdmissionCode,
  type AdmissionCode,
} from "./admission";
import { emptySlot, signingBytes, type Entry, type Slot } from "./state";
import { bytesToHex } from "./util";

const OWNER_SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(9);
/** Importing `./admission` initialises noble's sha512 hook first. */
const OWNER = bytesToHex(ed.getPublicKey(OWNER_SEED));
const OTHER = bytesToHex(ed.getPublicKey(OTHER_SEED));
const ME = OWNER;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    value: 0n,
    contact: ME,
    unit: null,
    note: null,
    ...overrides,
  };
}

function sign(
  slot: number,
  seq: number,
  value: Entry,
  seed = OWNER_SEED,
): string {
  return bytesToHex(ed.sign(signingBytes(slot, seq, value), seed));
}

function code(overrides: Partial<AdmissionCode> = {}): AdmissionCode {
  const value = overrides.entry ?? entry();
  const slot = overrides.slot ?? 5;
  const seq = overrides.seq ?? 3;
  return {
    owner: OWNER,
    candidate: ME,
    slot,
    seq,
    entry: value,
    address: "00",
    sig: sign(slot, seq, value),
    ...overrides,
  };
}

function record(overrides: Partial<Slot> = {}): Slot {
  return { seq: 3, entry: entry(), sig: null, ...overrides };
}

describe("admission code round-trip", () => {
  it("encodes, decodes and verifies a real slot signature", async () => {
    const original = code();
    const text = encodeAdmissionCode(original);
    expect(text.startsWith(ADMISSION_CODE_PREFIX)).toBe(true);

    const decoded = decodeAdmissionCode(text);
    expect(decoded).toMatchObject({ ok: true, code: original });

    const verified = await verifyAdmissionCode(text, { candidate: ME });
    expect(verified).toEqual({ ok: true, code: original });
  });

  it("keeps a full i64 value and optional text exact", async () => {
    const value = entry({
      value: -(2n ** 63n),
      unit: "cad",
      note: "hello",
    });
    const original = code({ entry: value });
    const verified = await verifyAdmissionCode(encodeAdmissionCode(original), {
      candidate: ME,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.code.entry.value).toBe(-(2n ** 63n));
      expect(verified.code.entry.unit).toBe("cad");
      expect(verified.code.entry.note).toBe("hello");
    }
  });

  it("tolerates whitespace and a surrounding link with ?admit=", async () => {
    const text = encodeAdmissionCode(code());
    expect(admissionCodeFromInput(`  ${text}  `)).toBe(text);
    expect(
      admissionCodeFromInput(`http://127.0.0.1:7511/v1/contract/web/x/?admit=${text}`),
    ).toBe(text);
    expect(admissionCodeFromInput(`admit=${text}`)).toBe(text);
    expect(admissionCodeFromInput(OWNER)).toBeNull();
    expect(admissionCodeFromInput("")).toBeNull();
  });

  it("derives the assigned address from the owner-reported one", () => {
    expect(admissionCodeAddress(code({ address: "00", slot: 4 }))).toBe("004");
    expect(admissionCodeAddress(code({ address: "", slot: 0 }))).toBe("0");
  });
});

describe("admission code rejection", () => {
  it("rejects a tampered value", async () => {
    const original = code();
    const tampered: AdmissionCode = {
      ...original,
      entry: { ...original.entry, value: 1n },
    };
    await expect(
      verifyAdmissionCode(encodeAdmissionCode(tampered), { candidate: ME }),
    ).resolves.toEqual({ ok: false, reason: "signature" });
  });

  it("binds the slot index", async () => {
    const original = code({ slot: 5 });
    const moved: AdmissionCode = { ...original, slot: 6 };
    await expect(
      verifyAdmissionCode(encodeAdmissionCode(moved), { candidate: ME }),
    ).resolves.toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a signature from a different key", async () => {
    const original = code();
    const foreign = sign(5, 3, original.entry, OTHER_SEED);
    await expect(
      verifyAdmissionCode(encodeAdmissionCode({ ...original, sig: foreign }), {
        candidate: ME,
      }),
    ).resolves.toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a code issued for another identity", async () => {
    const original = code({ candidate: OTHER, entry: entry({ contact: OTHER }) });
    await expect(
      verifyAdmissionCode(encodeAdmissionCode(original), { candidate: ME }),
    ).resolves.toEqual({ ok: false, reason: "candidate" });
  });

  it("refuses a code that would retarget an open flow", async () => {
    await expect(
      verifyAdmissionCode(encodeAdmissionCode(code({ owner: OTHER })), {
        candidate: ME,
        expectedOwner: OWNER,
      }),
    ).resolves.toEqual({ ok: false, reason: "owner" });
  });

  it("rejects malformed text, versions and bounds", async () => {
    await expect(
      verifyAdmissionCode("hello", { candidate: ME }),
    ).resolves.toEqual({ ok: false, reason: "format" });
    await expect(
      verifyAdmissionCode(`${ADMISSION_CODE_PREFIX}garbage!`, { candidate: ME }),
    ).resolves.toEqual({ ok: false, reason: "format" });

    const b64 = (value: unknown): string =>
      ADMISSION_CODE_PREFIX +
      Buffer.from(JSON.stringify(value)).toString("base64url");
    await expect(
      verifyAdmissionCode(b64({ v: 2 }), { candidate: ME }),
    ).resolves.toEqual({ ok: false, reason: "version" });
    await expect(
      verifyAdmissionCode(
        b64({
          v: 1,
          owner: OWNER,
          candidate: ME,
          slot: 8,
          seq: "1",
          value: "0",
          unit: null,
          note: null,
          address: "",
          sig: "0".repeat(128),
        }),
        { candidate: ME },
      ),
    ).resolves.toEqual({ ok: false, reason: "bounds" });
    await expect(
      verifyAdmissionCode(
        b64({
          v: 1,
          owner: OWNER,
          candidate: ME,
          slot: 0,
          seq: "0",
          value: "0",
          unit: null,
          note: null,
          address: "",
          sig: "0".repeat(128),
        }),
        { candidate: ME },
      ),
    ).resolves.toEqual({ ok: false, reason: "bounds" });
  });
});

describe("buildAdmissionCode", () => {
  it("refuses an unwritten slot", () => {
    expect(
      buildAdmissionCode({ owner: OWNER, slot: 0, record: emptySlot(), address: "" }),
    ).toBeNull();
    expect(
      buildAdmissionCode({
        owner: OWNER,
        slot: 0,
        record: record({ entry: null, seq: 2, sig: null }),
        address: "",
      }),
    ).toBeNull();
  });

  it("refuses a record without a signature or with a malformed address", () => {
    expect(
      buildAdmissionCode({ owner: OWNER, slot: 0, record: record(), address: "" }),
    ).toBeNull();
    expect(
      buildAdmissionCode({
        owner: OWNER,
        slot: 0,
        record: record({ sig: sign(0, 3, entry()) }),
        address: "08",
      }),
    ).toBeNull();
  });

  it("uses the signed slot entry and seq", async () => {
    const value = entry({ value: 1250n, note: "rent" });
    const built = buildAdmissionCode({
      owner: OWNER,
      slot: 2,
      record: { seq: 4, entry: value, sig: sign(2, 4, value) },
      address: "0",
    });
    expect(built).not.toBeNull();
    const verified = await verifyAdmissionCode(encodeAdmissionCode(built!), {
      candidate: ME,
    });
    expect(verified.ok).toBe(true);
  });
});

describe("crossCheckAdmission", () => {
  const original = code({ slot: 5, seq: 3 });

  it("treats an unreadable zone as no information", () => {
    expect(crossCheckAdmission(original, null)).toEqual({ kind: "unreadable" });
  });

  it("proceeds silently on a stale copy", () => {
    expect(
      crossCheckAdmission(
        original,
        { seq: 2, entry: entry({ contact: OTHER }), sig: "0".repeat(128) },
      ),
    ).toEqual({ kind: "stale" });
    expect(crossCheckAdmission(original, emptySlot())).toEqual({ kind: "stale" });
  });

  it("agrees at an equal or newer seq with the same entry", () => {
    const equal: Slot = { seq: 3, entry: entry(), sig: original.sig };
    expect(crossCheckAdmission(original, equal)).toEqual({
      kind: "agrees",
      slot: equal,
    });
    const newer: Slot = { seq: 6, entry: entry(), sig: original.sig };
    expect(crossCheckAdmission(original, newer)).toEqual({
      kind: "agrees",
      slot: newer,
    });
  });

  it("reports a newer designation that does not match", () => {
    expect(
      crossCheckAdmission(original, {
        seq: 4,
        entry: entry({ contact: OTHER }),
        sig: "0".repeat(128),
      }),
    ).toEqual({ kind: "changed", seq: 4 });
    expect(
      crossCheckAdmission(original, { seq: 4, entry: null, sig: "0".repeat(128) }),
    ).toEqual({ kind: "changed", seq: 4 });
  });
});

describe("admissionFailureText", () => {
  it("has readable copy for every reason", () => {
    for (const reason of [
      "format",
      "version",
      "bounds",
      "owner",
      "candidate",
      "signature",
    ] as const) {
      expect(admissionFailureText(reason).length).toBeGreaterThan(10);
    }
  });
});
