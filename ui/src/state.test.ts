import { describe, expect, it } from "vitest";
import {
  CENTS_MAX,
  CENTS_RANGE,
  I64_MAX,
  I64_MIN,
  LEGACY_STATE_VERSION,
  LIMITS,
  MAX_CONTACTS,
  StateError,
  computeDelta,
  contactsDigest16,
  contactsSigningBytes,
  decodeDelta,
  decodeState,
  decodeSummary,
  emptyContacts,
  emptyParent,
  emptyState,
  encodeDelta,
  encodeState,
  encodeSummary,
  entryFromInputs,
  formatCents,
  isI64,
  mergeContacts,
  mergeDelta,
  mergeParent,
  mergeStates,
  optionalText,
  parentDigest16,
  parentSigningBytes,
  parseCents,
  signingBytes,
  slotDigest16,
  stateWarnings,
  summaryFromState,
  validateContacts,
  validateDelta,
  validateEntry,
  validateParent,
  validateState,
  validateSummary,
  type Contact,
  type ContactsRecord,
  type Entry,
  type ParentRecord,
  type Slot,
  type StateV3,
} from "./state";
import { bytesToHex } from "./util";

const SIG_A = "a".repeat(128);
const SIG_B = "b".repeat(128);
const SIG_C = "c".repeat(128);

const CONTACT_A = "11".repeat(32);
const CONTACT_B = "22".repeat(32);
/** A userId with hex letters, for lowercase checks. */
const CONTACT_HEX = "ab".repeat(32);

// Spec §2.5 golden vectors.
const GOLDEN_SLOT_BYTES =
  "6e756d6265723a76323a736c6f74030700000000000000010c00000000000000" +
  "1111111111111111111111111111111111111111111111111111111111111111" +
  "0000000000000000";
const GOLDEN_SLOT_DIGEST16 = "d6f77f8b222a3ee76101db6e6f662e7c";

const GOLDEN_CONTACTS_BYTES =
  "6e756d6265723a76323a636f6e7461637473" + // "number:v2:contacts"
  "0100000000000000" + // seq 1
  "01000000" + // count
  "05000000" + // label length
  "416c696365" + // "Alice"
  "1111111111111111111111111111111111111111111111111111111111111111";
const GOLDEN_CONTACTS_DIGEST16 = "415fee80ba4f302cac4cd169a7f075a4";

// Spec §2/§4: parent signing bytes, seq 1, userId 0x11 × 32.
const PARENT_USER = "11".repeat(32);
const GOLDEN_PARENT_BYTES =
  "6e756d6265723a76333a706172656e74" + // "number:v3:parent"
  "0100000000000000" + // seq 1
  "01" + // tag: parent set
  PARENT_USER;
const GOLDEN_PARENT_DIGEST16 = "a3b70e503d1951bb363f6fbf310d4782";
const GOLDEN_PARENT_CLEARED_BYTES =
  "6e756d6265723a76333a706172656e74" + "0100000000000000" + "00"; // tag: cleared
const GOLDEN_PARENT_CLEARED_DIGEST16 = "3b38efbfcc7bd18dce1d5e265151e9f0";

function entry(value: number | bigint, overrides: Partial<Entry> = {}): Entry {
  return {
    value: typeof value === "bigint" ? value : BigInt(value),
    contact: CONTACT_A,
    unit: null,
    note: null,
    ...overrides,
  };
}

function contact(label: string, userId = CONTACT_A): Contact {
  return { label, userId };
}

function contacts(overrides: Partial<ContactsRecord> = {}): ContactsRecord {
  return { seq: 0, entries: [], sig: null, ...overrides };
}

function stateWith(
  slots: Record<number, Slot>,
  record: ContactsRecord = emptyContacts(),
  parent: ParentRecord = emptyParent(),
): StateV3 {
  const state = emptyState();
  state.parent = { ...parent };
  state.contacts = {
    seq: record.seq,
    entries: record.entries.map((item) => ({ ...item })),
    sig: record.sig,
  };
  for (const [index, slot] of Object.entries(slots)) {
    state.slots[Number(index)] = {
      seq: slot.seq,
      entry: slot.entry === null ? null : { ...slot.entry },
      sig: slot.sig,
    };
  }
  return state;
}

describe("golden vectors (spec §2.5)", () => {
  it("builds the exact slot signing bytes and digest16", () => {
    expect(bytesToHex(signingBytes(3, 7, entry(12)))).toBe(GOLDEN_SLOT_BYTES);
    expect(
      slotDigest16(3, { seq: 7, entry: entry(12), sig: SIG_A }),
    ).toBe(GOLDEN_SLOT_DIGEST16);
    expect(slotDigest16(3, { seq: 0, entry: null, sig: null })).toBe(
      "0".repeat(32),
    );
  });

  it("builds the exact contacts signing bytes and digest16", () => {
    const record = contacts({
      seq: 1,
      entries: [contact("Alice", CONTACT_A)],
      sig: SIG_A,
    });
    expect(bytesToHex(contactsSigningBytes(1, record.entries))).toBe(
      GOLDEN_CONTACTS_BYTES,
    );
    expect(contactsDigest16(record)).toBe(GOLDEN_CONTACTS_DIGEST16);
    expect(contactsDigest16(emptyContacts())).toBe("0".repeat(32));
  });

  it("signs an empty contact list with seq > 0 as count 0", () => {
    expect(bytesToHex(contactsSigningBytes(4, []))).toBe(
      "6e756d6265723a76323a636f6e7461637473" +
        "0400000000000000" +
        "00000000",
    );
  });

  it("builds the exact parent signing bytes and digest16", () => {
    expect(bytesToHex(parentSigningBytes(1, PARENT_USER))).toBe(
      GOLDEN_PARENT_BYTES,
    );
    expect(
      parentDigest16({ seq: 1, userId: PARENT_USER, sig: SIG_A }),
    ).toBe(GOLDEN_PARENT_DIGEST16);
    expect(bytesToHex(parentSigningBytes(1, null))).toBe(
      GOLDEN_PARENT_CLEARED_BYTES,
    );
    expect(parentDigest16({ seq: 1, userId: null, sig: SIG_A })).toBe(
      GOLDEN_PARENT_CLEARED_DIGEST16,
    );
    expect(parentDigest16(emptyParent())).toBe("0".repeat(32));
  });
});

describe("state encode/decode", () => {
  it("round-trips the exact v3 state shape, including tombstones", () => {
    const state = stateWith(
      {
        0: { seq: 0, entry: null, sig: null },
        3: {
          seq: 3,
          entry: entry(-42, { unit: "kg", note: "morning" }),
          sig: SIG_A,
        },
        7: { seq: 1, entry: null, sig: SIG_B },
      },
      contacts({ seq: 2, entries: [contact("Alice")], sig: SIG_C }),
    );

    const encoded = encodeState(state);
    expect(decodeState(encoded)).toEqual(state);

    const json = JSON.parse(new TextDecoder().decode(encoded));
    expect(json.v).toBe(3);
    expect(json.parent).toEqual(emptyParent());
    expect(json.contacts).toEqual({
      seq: 2,
      entries: [{ label: "Alice", userId: CONTACT_A }],
      sig: SIG_C,
    });
    expect(json.slots).toHaveLength(8);
    expect(json.slots[3]).toEqual({
      seq: 3,
      entry: { value: -42, contact: CONTACT_A, unit: "kg", note: "morning" },
      sig: SIG_A,
    });
    expect(json.slots[7]).toEqual({ seq: 1, entry: null, sig: SIG_B });
  });

  it("normalises absent value and empty optional strings", () => {
    const state = validateState({
      v: 3,
      parent: emptyParent(),
      contacts: { seq: 0, entries: [], sig: null },
      slots: emptyState().slots.map((slot, index) => {
        if (index === 2) {
          return { seq: 1, entry: { contact: CONTACT_A }, sig: SIG_A };
        }
        if (index === 3) {
          return {
            seq: 1,
            entry: { value: 8, contact: CONTACT_A, unit: "", note: "" },
            sig: SIG_B,
          };
        }
        return slot;
      }),
    });

    expect(state.slots[2].entry).toEqual({
      value: 0n,
      contact: CONTACT_A,
      unit: null,
      note: null,
    });
    expect(state.slots[3].entry).toEqual({
      value: 8n,
      contact: CONTACT_A,
      unit: null,
      note: null,
    });
    expect(optionalText("  ")).toBeNull();
    expect(optionalText("  kg ")).toBe("kg");
  });

  it("round-trips delta and summary encodings with contacts", () => {
    const delta = {
      v: 3 as const,
      parent: null,
      contacts: contacts({ seq: 2, entries: [contact("Alice")], sig: SIG_C }),
      slots: [
        { i: 2, seq: 4, entry: entry(8, { unit: "kg" }), sig: SIG_C },
        { i: 5, seq: 9, entry: null, sig: SIG_A },
      ],
    };
    expect(decodeDelta(encodeDelta(delta))).toEqual(delta);

    const summary = summaryFromState(
      stateWith(
        { 3: { seq: 7, entry: entry(12), sig: SIG_A } },
        contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_B }),
      ),
    );
    expect(decodeSummary(encodeSummary(summary))).toEqual(summary);
    expect(summary.v).toBe(3);
    expect(summary.parent).toEqual([0, "0".repeat(32)]);
    expect(summary.contacts).toEqual([1, GOLDEN_CONTACTS_DIGEST16]);
    expect(summary.slots).toHaveLength(8);
    expect(summary.slots[0]).toEqual([0, "0".repeat(32)]);
    expect(summary.slots[3][1]).toBe(GOLDEN_SLOT_DIGEST16);
  });

  it("accepts an absent or null delta contacts record", () => {
    for (const raw of [
      { v: 3, slots: [] },
      { v: 3, parent: null, contacts: null, slots: [] },
    ]) {
      expect(validateDelta(raw).contacts).toBeNull();
    }
  });

  it("rejects malformed JSON/state/delta/summary", () => {
    expect(() => decodeState("{not json")).toThrow(StateError);
    expect(() =>
      validateState({ v: 1, contacts: emptyContacts(), slots: emptyState().slots }),
    ).toThrow(/state\.v/);
    expect(() =>
      validateState({ v: 3, parent: emptyParent(), slots: emptyState().slots }),
    ).toThrow(/state\.contacts/);
    expect(() =>
      validateState({
        v: 3,
        parent: emptyParent(),
        contacts: emptyContacts(),
        slots: emptyState().slots.slice(0, 7),
      }),
    ).toThrow(/exactly 8/);
    expect(() =>
      validateDelta({
        v: 3,
        parent: null,
        contacts: null,
        slots: [
          { i: 1, seq: 1, entry: entry(1), sig: SIG_A },
          { i: 1, seq: 2, entry: entry(2), sig: SIG_B },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      validateSummary({ v: 3, parent: [0, "0".repeat(32)], contacts: [0, "0".repeat(32)], slots: [] }),
    ).toThrow(/exactly 8/);
    expect(() =>
      validateSummary({ v: 3, slots: [] }),
    ).toThrow(/summary\.parent/);
  });
});

describe("v2 → v3 upgrade", () => {
  it("normalises a v2 state to v3 with an empty parent", () => {
    const v2 = {
      v: LEGACY_STATE_VERSION,
      contacts: contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A }),
      slots: emptyState().slots,
    };
    const upgraded = validateState(v2);
    expect(upgraded.v).toBe(3);
    expect(upgraded.parent).toEqual(emptyParent());
    expect(upgraded.contacts).toEqual(v2.contacts);

    // A v2 state's slot/contacts signatures are unchanged, so encoding writes
    // the same records under v3.
    const json = JSON.parse(new TextDecoder().decode(encodeState(upgraded)));
    expect(json.v).toBe(3);
    expect(json.parent).toEqual({ seq: 0, userId: null, sig: null });
    expect(json.contacts).toEqual(v2.contacts);
  });

  it("rejects a v2 state that carries a parent", () => {
    for (const parent of [emptyParent(), null, { seq: 1, userId: CONTACT_A, sig: SIG_A }]) {
      expect(() =>
        validateState({
          v: LEGACY_STATE_VERSION,
          parent,
          contacts: emptyContacts(),
          slots: emptyState().slots,
        }),
      ).toThrow(/v2 state must not carry a parent/);
    }
  });

  it("rejects an unknown state version and a v3 state without a parent", () => {
    expect(() =>
      validateState({ v: 1, contacts: emptyContacts(), slots: emptyState().slots }),
    ).toThrow(/state\.v/);
    expect(() =>
      validateState({ v: 3, contacts: emptyContacts(), slots: emptyState().slots }),
    ).toThrow(/state\.parent/);
  });
});

describe("parent codec", () => {
  it("accepts a root, a set parent, and a cleared parent", () => {
    expect(validateParent({ seq: 0, userId: null, sig: null })).toEqual(
      emptyParent(),
    );
    expect(validateParent({ seq: 3, userId: CONTACT_B, sig: SIG_A })).toEqual({
      seq: 3,
      userId: CONTACT_B,
      sig: SIG_A,
    });
    expect(validateParent({ seq: 3, userId: null, sig: SIG_A })).toEqual({
      seq: 3,
      userId: null,
      sig: SIG_A,
    });
  });

  it("rejects impossible seq/userId/sig combinations", () => {
    expect(() =>
      validateParent({ seq: 0, userId: CONTACT_A, sig: null }),
    ).toThrow(/seq 0 must have a null userId/);
    expect(() =>
      validateParent({ seq: 0, userId: null, sig: SIG_A }),
    ).toThrow(/seq 0 must have a null signature/);
    expect(() =>
      validateParent({ seq: 1, userId: CONTACT_A, sig: null }),
    ).toThrow(/requires a signature/);
    expect(() =>
      validateParent({ seq: 1, userId: "AB".repeat(32), sig: SIG_A }),
    ).toThrow(/userId/);
    expect(() =>
      validateParent({ seq: 1, userId: CONTACT_A, sig: "A".repeat(128) }),
    ).toThrow(/lowercase hex/);
    expect(() => validateParent(null)).toThrow(/expected an object/);
  });

  it("does not enforce self-parent (that is a UI/contract rule)", () => {
    // Format-only: a parent id equal to the owner is structurally valid here.
    expect(
      validateParent({ seq: 1, userId: CONTACT_A, sig: SIG_A }).userId,
    ).toBe(CONTACT_A);
  });
});

describe("parent in state, delta, summary, merge", () => {
  it("round-trips a v3 state with a parent", () => {
    const state = stateWith(
      { 0: { seq: 1, entry: entry(5), sig: SIG_A } },
      contacts({ seq: 2, entries: [contact("Alice")], sig: SIG_B }),
      { seq: 4, userId: CONTACT_B, sig: SIG_C },
    );
    const encoded = encodeState(state);
    const json = JSON.parse(new TextDecoder().decode(encoded));
    expect(json.v).toBe(3);
    expect(json.parent).toEqual({
      seq: 4,
      userId: CONTACT_B,
      sig: SIG_C,
    });
    expect(decodeState(encoded)).toEqual(state);
  });

  it("includes the parent pair in the summary", () => {
    const summary = summaryFromState(
      stateWith({}, emptyContacts(), {
        seq: 1,
        userId: PARENT_USER,
        sig: SIG_A,
      }),
    );
    expect(summary.parent).toEqual([1, GOLDEN_PARENT_DIGEST16]);
    const cleared = summaryFromState(
      stateWith({}, emptyContacts(), { seq: 1, userId: null, sig: SIG_A }),
    );
    expect(cleared.parent).toEqual([1, GOLDEN_PARENT_CLEARED_DIGEST16]);
    expect(summaryFromState(emptyState()).parent).toEqual([0, "0".repeat(32)]);
  });

  it("includes a newer parent in computeDelta", () => {
    const ours = stateWith({}, emptyContacts(), {
      seq: 2,
      userId: CONTACT_B,
      sig: SIG_B,
    });
    const theirs = stateWith({}, emptyContacts(), {
      seq: 1,
      userId: CONTACT_A,
      sig: SIG_A,
    });
    expect(computeDelta(ours, theirs).parent).toEqual(ours.parent);
    expect(computeDelta(theirs, ours).parent).toBeNull();
    expect(computeDelta(ours, ours).parent).toBeNull();
    expect(computeDelta(emptyState(), emptyState())).toEqual({
      v: 3,
      parent: null,
      contacts: null,
      slots: [],
    });
  });

  it("includes a parent at equal seq when the digests diverge", () => {
    const a = stateWith({}, emptyContacts(), {
      seq: 2,
      userId: CONTACT_A,
      sig: SIG_A,
    });
    const b = stateWith({}, emptyContacts(), {
      seq: 2,
      userId: CONTACT_B,
      sig: SIG_B,
    });
    expect(computeDelta(a, b).parent).toEqual(a.parent);
  });

  it("round-trips a parent delta and lets stale parents lose", () => {
    const base = stateWith({}, emptyContacts(), {
      seq: 2,
      userId: CONTACT_A,
      sig: SIG_A,
    });
    const delta = {
      v: 3 as const,
      parent: { seq: 3, userId: CONTACT_B, sig: SIG_B },
      contacts: null,
      slots: [],
    };
    expect(decodeDelta(encodeDelta(delta))).toEqual(delta);

    const next = mergeDelta(base, delta);
    expect(next.parent).toEqual(delta.parent);

    const stale = {
      v: 3 as const,
      parent: { seq: 1, userId: null, sig: SIG_C },
      contacts: null,
      slots: [],
    };
    expect(mergeDelta(next, stale).parent).toEqual(delta.parent);
  });

  it("merges parent by seq, then signature bytes, including a null tombstone", () => {
    const low = { seq: 1, userId: CONTACT_A, sig: SIG_A };
    const high = { seq: 2, userId: CONTACT_B, sig: SIG_A };
    expect(mergeParent(low, high)).toEqual(high);
    expect(mergeParent(high, low)).toEqual(high);

    const tieLow = { seq: 2, userId: CONTACT_A, sig: SIG_A };
    const tieHigh = { seq: 2, userId: CONTACT_B, sig: SIG_B };
    expect(mergeParent(tieLow, tieHigh)).toEqual(tieHigh);
    expect(mergeParent(tieHigh, tieLow)).toEqual(tieHigh);

    // A cleared parent (null userId) at the higher seq is a legal tombstone.
    const cleared = { seq: 3, userId: null, sig: SIG_C };
    expect(mergeParent(tieHigh, cleared)).toEqual(cleared);
    expect(mergeParent(cleared, tieHigh)).toEqual(cleared);

    expect(mergeStates(
      stateWith({}, emptyContacts(), low),
      stateWith({}, emptyContacts(), high),
    ).parent).toEqual(high);
  });
});

describe("contacts validation", () => {
  it("accepts a legal record and preserves entry order", () => {
    const record = validateContacts({
      seq: 3,
      entries: [
        { label: "Bob", userId: CONTACT_B },
        { label: "Alice", userId: CONTACT_A },
      ],
      sig: SIG_A,
    });
    expect(record.entries.map((item) => item.label)).toEqual(["Bob", "Alice"]);
  });

  it("enforces the label bounds in UTF-8 bytes", () => {
    expect(() => validateContacts(contacts({
      seq: 1,
      entries: [contact("a".repeat(LIMITS.label))],
      sig: SIG_A,
    }))).not.toThrow();
    expect(() => validateContacts(contacts({
      seq: 1,
      entries: [contact("a".repeat(LIMITS.label + 1))],
      sig: SIG_A,
    }))).toThrow(/64-byte limit/);
    // "é" is 2 bytes: 32 chars = 64 bytes, 33 chars = 66 bytes.
    expect(() => validateContacts(contacts({
      seq: 1,
      entries: [contact("é".repeat(32))],
      sig: SIG_A,
    }))).not.toThrow();
    expect(() => validateContacts(contacts({
      seq: 1,
      entries: [contact("é".repeat(33))],
      sig: SIG_A,
    }))).toThrow(/64-byte limit/);
    expect(() => validateContacts(contacts({
      seq: 1,
      entries: [contact("")],
      sig: SIG_A,
    }))).toThrow(/must not be empty/);
  });

  it("requires a lowercase 64-hex userId", () => {
    for (const userId of [
      CONTACT_A.slice(0, 62),
      CONTACT_HEX.toUpperCase(),
      "zz".repeat(32),
      42,
      undefined,
    ]) {
      expect(() =>
        validateContacts(contacts({
          seq: 1,
          entries: [{ label: "Alice", userId } as unknown as Contact],
          sig: SIG_A,
        })),
      ).toThrow(/userId/);
    }
  });

  it("rejects duplicate userIds and duplicate labels", () => {
    expect(() =>
      validateContacts(contacts({
        seq: 1,
        entries: [contact("Alice", CONTACT_A), contact("Bob", CONTACT_A)],
        sig: SIG_A,
      })),
    ).toThrow(/duplicate userId/);

    expect(() =>
      validateContacts(contacts({
        seq: 1,
        entries: [contact("Alice", CONTACT_A), contact("Alice", CONTACT_B)],
        sig: SIG_A,
      })),
    ).toThrow(/duplicate label/);
  });

  it("enforces the contact count and seq/sig invariants", () => {
    const many = Array.from({ length: MAX_CONTACTS + 1 }, (_, index) => ({
      label: `c${index}`,
      userId: index.toString(16).padStart(64, "0"),
    }));
    expect(() =>
      validateContacts(contacts({ seq: 1, entries: many, sig: SIG_A })),
    ).toThrow(new RegExp(`at most ${MAX_CONTACTS}`));

    expect(() =>
      validateContacts(contacts({ seq: 0, entries: [contact("Alice")], sig: null })),
    ).toThrow(/seq 0 must have no contacts/);
    expect(() =>
      validateContacts(contacts({ seq: 0, entries: [], sig: SIG_A })),
    ).toThrow(/seq 0 must have a null signature/);
    expect(() =>
      validateContacts(contacts({ seq: 1, entries: [], sig: null })),
    ).toThrow(/requires a signature/);
    expect(() =>
      validateContacts(contacts({ seq: 1, entries: [], sig: "A".repeat(128) })),
    ).toThrow(/lowercase hex/);

    // An empty contact list at seq > 0 is a legal tombstone.
    expect(
      validateContacts(contacts({ seq: 9, entries: [], sig: SIG_A })),
    ).toEqual({ seq: 9, entries: [], sig: SIG_A });
  });

  it("validates entries inside a state atomically", () => {
    const bad = stateWith({});
    bad.contacts = contacts({ seq: 1, entries: [contact("Alice")], sig: null });
    expect(() => validateState(bad)).toThrow(/contacts/);
  });
});

describe("entry validation and cents helpers", () => {
  it("requires a valid contact and i64 value", () => {
    expect(() => validateEntry({ value: 1, contact: CONTACT_A })).not.toThrow();
    expect(() => validateEntry({ value: 1, contact: CONTACT_HEX.toUpperCase() }))
      .toThrow(/contact/);
    expect(() => validateEntry({ value: 1 })).toThrow(/contact/);
    expect(() => validateEntry({ contact: CONTACT_A, unit: "u".repeat(17) }))
      .toThrow(/16-byte limit/);
    expect(() => validateEntry({ contact: CONTACT_A, note: "n".repeat(513) }))
      .toThrow(/512-byte limit/);
    expect(() => validateEntry({ value: 1.5, contact: CONTACT_A })).toThrow(
      /integer/,
    );
    expect(() => validateEntry({ value: 2 ** 63, contact: CONTACT_A })).toThrow(
      /exact integer/,
    );
    expect(() =>
      validateEntry({ value: I64_MAX + 1n, contact: CONTACT_A }),
    ).toThrow(/signed 64-bit/);
  });

  it("builds entries from form inputs", () => {
    expect(entryFromInputs(1250n, ` ${CONTACT_A.toUpperCase()} `, " kg ", " ")).toEqual({
      value: 1250n,
      contact: CONTACT_A,
      unit: "kg",
      note: null,
    });
  });

  it("parses blank and simple decimals exactly", () => {
    const cases: Array<[string, bigint]> = [
      ["", 0n],
      ["   ", 0n],
      ["0", 0n],
      ["-0", 0n],
      ["12", 1200n],
      ["12.", 1200n],
      ["12.5", 1250n],
      [".5", 50n],
      ["-.5", -50n],
      ["+3.05", 305n],
      ["-0.01", -1n],
      [" 1250.00 ", 125000n],
      ["-42.42", -4242n],
    ];
    for (const [input, expected] of cases) {
      expect(parseCents(input)).toBe(expected);
    }
  });

  it("rejects malformed decimals with a human message", () => {
    for (const input of [
      "1e3",
      "1.234",
      "1,000",
      "1 2",
      "--1",
      "+-1",
      "1.2.3",
      "abc",
      ".",
      "+",
    ]) {
      expect(() => parseCents(input)).toThrow(StateError);
    }
    expect(() => parseCents("1.234")).toThrow(/at most 2 decimal places/);
    expect(() => parseCents("abc")).toThrow(/amount/i);
  });

  it("covers the exact i64 cents boundary", () => {
    expect(parseCents(CENTS_MAX)).toBe(I64_MAX);
    expect(parseCents(CENTS_RANGE)).toBe(I64_MIN);
    expect(parseCents("92233720368547758")).toBe(9223372036854775800n);
    expect(() => parseCents("92233720368547758.08")).toThrow(
      /between -92233720368547758\.08 and 92233720368547758\.07/,
    );
    expect(() => parseCents("-92233720368547758.09")).toThrow(
      /between -92233720368547758\.08 and 92233720368547758\.07/,
    );
    expect(() => parseCents("99999999999999999999")).toThrow(/between/);
  });

  it("formats every boundary exactly with two decimals", () => {
    expect(formatCents(0n)).toBe("0.00");
    expect(formatCents(1n)).toBe("0.01");
    expect(formatCents(-1n)).toBe("-0.01");
    expect(formatCents(1250n)).toBe("12.50");
    expect(formatCents(-1250n)).toBe("-12.50");
    expect(formatCents(100n)).toBe("1.00");
    expect(formatCents(I64_MIN)).toBe(CENTS_RANGE);
    expect(formatCents(I64_MAX)).toBe(CENTS_MAX);
    for (const value of [0n, 1n, -1n, 1250n, -987654321n, I64_MIN, I64_MAX]) {
      expect(parseCents(formatCents(value))).toBe(value);
    }
  });
});

describe("merge determinism", () => {
  it("is commutative and idempotent for different slot seqs", () => {
    const low = stateWith({ 0: { seq: 1, entry: entry(1), sig: SIG_A } });
    const high = stateWith({ 0: { seq: 2, entry: entry(2), sig: SIG_A } });

    expect(mergeStates(low, high)).toEqual(high);
    expect(mergeStates(high, low)).toEqual(high);
    expect(mergeStates(high, high)).toEqual(high);
  });

  it("breaks equal-seq slot ties on signature bytes, symmetrically", () => {
    const a = stateWith({ 4: { seq: 2, entry: entry(10), sig: SIG_A } });
    const b = stateWith({ 4: { seq: 2, entry: entry(20), sig: SIG_B } });

    expect(mergeStates(a, b).slots[4].entry?.value).toBe(20n);
    expect(mergeStates(b, a).slots[4].entry?.value).toBe(20n);
    expect(mergeStates(a, b)).toEqual(mergeStates(b, a));
  });

  it("is associative across three states", () => {
    const a = stateWith({ 1: { seq: 1, entry: entry(1), sig: SIG_A } });
    const b = stateWith({ 1: { seq: 2, entry: entry(2), sig: SIG_A } });
    const c = stateWith({ 1: { seq: 2, entry: entry(3), sig: SIG_C } });

    expect(mergeStates(mergeStates(a, b), c)).toEqual(
      mergeStates(a, mergeStates(b, c)),
    );
    expect(mergeStates(mergeStates(a, b), c).slots[1].entry?.value).toBe(3n);
  });

  it("merges contacts by seq then signature bytes", () => {
    const low = contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A });
    const high = contacts({ seq: 2, entries: [contact("Bob", CONTACT_B)], sig: SIG_A });

    expect(mergeContacts(low, high)).toEqual(high);
    expect(mergeContacts(high, low)).toEqual(high);
    expect(mergeContacts(high, high)).toEqual(high);

    const tieA = contacts({ seq: 3, entries: [contact("Alice")], sig: SIG_A });
    const tieB = contacts({ seq: 3, entries: [contact("Bob", CONTACT_B)], sig: SIG_B });
    expect(mergeContacts(tieA, tieB)).toEqual(tieB);
    expect(mergeContacts(tieB, tieA)).toEqual(tieB);
  });

  it("is deterministic when seq and sig agree but entries differ", () => {
    const a = contacts({ seq: 3, entries: [contact("Alice")], sig: SIG_A });
    const b = contacts({ seq: 3, entries: [contact("Bob", CONTACT_B)], sig: SIG_A });
    expect(mergeContacts(a, b)).toEqual(mergeContacts(b, a));
  });

  it("keeps slots and contacts independent in a full merge", () => {
    const a = stateWith(
      { 0: { seq: 1, entry: entry(1), sig: SIG_A } },
      contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A }),
    );
    const b = stateWith(
      { 0: { seq: 2, entry: entry(2), sig: SIG_B } },
      contacts({ seq: 0, entries: [], sig: null }),
    );
    const merged = mergeStates(a, b);
    expect(merged.slots[0]).toEqual(b.slots[0]);
    expect(merged.contacts).toEqual(a.contacts);
  });

  it("applies a contacts-only delta and lets stale contacts lose", () => {
    const base = stateWith(
      { 0: { seq: 2, entry: entry(2), sig: SIG_B } },
      contacts({ seq: 2, entries: [contact("Alice")], sig: SIG_B }),
    );
    const delta = {
      v: 3 as const,
      parent: null,
      contacts: contacts({ seq: 3, entries: [contact("Bob", CONTACT_B)], sig: SIG_C }),
      slots: [],
    };
    const next = mergeDelta(base, delta);
    expect(next.contacts).toEqual(delta.contacts);
    expect(next.slots).toEqual(base.slots);

    const stale = {
      v: 3 as const,
      parent: null,
      contacts: contacts({ seq: 1, entries: [contact("Old", CONTACT_A)], sig: SIG_A }),
      slots: [],
    };
    expect(mergeDelta(next, stale).contacts).toEqual(delta.contacts);
  });

  it("treats a repeated delta as a no-op and lets stale slots lose", () => {
    const base = stateWith({ 0: { seq: 2, entry: entry(2), sig: SIG_B } });
    const stale = {
      v: 3 as const,
      parent: null,
      contacts: null,
      slots: [{ i: 0, seq: 1, entry: entry(1), sig: SIG_A }],
    };
    expect(mergeDelta(base, stale)).toEqual(base);

    const fresh = {
      v: 3 as const,
      parent: null,
      contacts: null,
      slots: [{ i: 0, seq: 3, entry: entry(3), sig: SIG_C }],
    };
    const once = mergeDelta(base, fresh);
    expect(mergeDelta(once, fresh)).toEqual(once);
  });
});

describe("delta filtering", () => {
  it("returns a literally empty delta when converged", () => {
    const state = stateWith(
      {
        2: { seq: 4, entry: entry(8), sig: SIG_A },
        7: { seq: 1, entry: null, sig: SIG_B },
      },
      contacts({ seq: 2, entries: [contact("Alice")], sig: SIG_C }),
    );
    expect(computeDelta(state, state)).toEqual({
      v: 3,
      parent: null,
      contacts: null,
      slots: [],
    });
    expect(
      JSON.parse(new TextDecoder().decode(encodeDelta(computeDelta(state, state)))),
    ).toEqual({ v: 3, parent: null, contacts: null, slots: [] });
  });

  it("includes contacts when ours is newer, otherwise leaves them null", () => {
    const theirs = stateWith(
      {},
      contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A }),
    );
    const ours = stateWith(
      {},
      contacts({ seq: 2, entries: [contact("Alice"), contact("Bob", CONTACT_B)], sig: SIG_B }),
    );

    expect(computeDelta(ours, theirs).contacts).toEqual(ours.contacts);
    expect(computeDelta(theirs, ours).contacts).toBeNull();

    const newSubscriber = computeDelta(ours, emptyState());
    expect(newSubscriber.contacts).toEqual(ours.contacts);
    expect(computeDelta(emptyState(), emptyState()).contacts).toBeNull();
  });

  it("includes contacts at equal seq when the digests diverge", () => {
    const a = stateWith(
      {},
      contacts({ seq: 2, entries: [contact("Alice")], sig: SIG_A }),
    );
    const b = stateWith(
      {},
      contacts({ seq: 2, entries: [contact("Bob", CONTACT_B)], sig: SIG_B }),
    );
    const delta = computeDelta(a, b);
    expect(delta.contacts).toEqual(a.contacts);
    expect(delta.slots).toEqual([]);
  });

  it("includes newer slots and equal-seq digest divergence, not stale slots", () => {
    const ours = stateWith({
      0: { seq: 3, entry: entry(30), sig: SIG_A },
      1: { seq: 2, entry: entry(20), sig: SIG_A },
      2: { seq: 1, entry: entry(10), sig: SIG_A },
    });
    const theirs = stateWith({
      0: { seq: 1, entry: entry(1), sig: SIG_C },
      1: { seq: 2, entry: entry(999), sig: SIG_C },
      2: { seq: 5, entry: entry(50), sig: SIG_C },
    });

    const delta = computeDelta(ours, theirs);
    expect(delta.slots.map((slot) => slot.i)).toEqual([0, 1]);
    expect(delta.slots[0]).toMatchObject({ i: 0, seq: 3 });
    expect(delta.slots[1]).toMatchObject({ i: 1, seq: 2 });
  });

  it("includes a contacts-only delta and empty slots", () => {
    const ours = stateWith(
      { 2: { seq: 2, entry: entry(10), sig: SIG_A } },
      contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_B }),
    );
    const theirs = stateWith(
      { 2: { seq: 2, entry: entry(10), sig: SIG_A } },
      emptyContacts(),
    );
    const delta = computeDelta(ours, theirs);
    expect(delta.slots).toEqual([]);
    expect(delta.contacts).toEqual(ours.contacts);
  });

  it("ignores empty slots and includes tombstones with seq > 0", () => {
    const ours = stateWith({
      0: { seq: 0, entry: null, sig: null },
      5: { seq: 6, entry: null, sig: SIG_A },
    });
    const delta = computeDelta(ours, emptyState());
    expect(delta.slots).toEqual([
      { i: 5, seq: 6, entry: null, sig: SIG_A },
    ]);
  });
});

describe("bounds and invariants", () => {
  it("enforces unit and note UTF-8 byte limits", () => {
    expect(() => validateEntry(entry(1, { unit: "u".repeat(16) }))).not.toThrow();
    expect(() => validateEntry(entry(1, { unit: "u".repeat(17) }))).toThrow(
      /16-byte limit/,
    );
    expect(() => validateEntry(entry(1, { note: "n".repeat(512) }))).not.toThrow();
    expect(() => validateEntry(entry(1, { note: "n".repeat(513) }))).toThrow(
      /512-byte limit/,
    );
  });

  it("requires integer i64 values", () => {
    expect(isI64(-42)).toBe(true);
    expect(isI64(Number(I64_MIN))).toBe(true);
    expect(isI64(2 ** 63)).toBe(false);
    expect(() => validateEntry({ value: 1.5, contact: CONTACT_A })).toThrow(
      /integer/,
    );
    expect(() => validateEntry({ value: "1", contact: CONTACT_A })).toThrow(
      /integer/,
    );
  });

  it("enforces slot seq-0 and signature invariants atomically", () => {
    expect(() =>
      validateState({
        v: 3,
        parent: emptyParent(),
        contacts: emptyContacts(),
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 0, entry: entry(1), sig: null } : slot,
        ),
      }),
    ).toThrow(/seq 0 must have a null entry/);

    expect(() =>
      validateState({
        v: 3,
        parent: emptyParent(),
        contacts: emptyContacts(),
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 0, entry: null, sig: SIG_A } : slot,
        ),
      }),
    ).toThrow(/seq 0 must have a null signature/);

    expect(() =>
      validateState({
        v: 3,
        parent: emptyParent(),
        contacts: emptyContacts(),
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 1, entry: entry(1), sig: null } : slot,
        ),
      }),
    ).toThrow(/requires a signature/);

    expect(() =>
      validateState({
        v: 3,
        parent: emptyParent(),
        contacts: emptyContacts(),
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 1, entry: entry(1), sig: "A".repeat(128) } : slot,
        ),
      }),
    ).toThrow(/lowercase hex/);

    expect(() =>
      validateDelta({
        v: 3,
        parent: null,
        contacts: null,
        slots: [{ i: 8, seq: 1, entry: entry(1), sig: SIG_A }],
      }),
    ).toThrow(/0\.\.7/);
  });

  it("round-trips the full i64 range exactly", () => {
    const values = [
      I64_MIN,
      I64_MAX,
      I64_MIN + 1n,
      I64_MAX - 1n,
      9007199254740993n, // 2^53 + 1, the first value a JS number rounds
      -9007199254740993n,
    ];
    for (const value of values) {
      const state = stateWith({
        0: { seq: 1, entry: entry(value), sig: SIG_A },
      });
      const encoded = encodeState(state);
      const text = new TextDecoder().decode(encoded);
      expect(text).toContain(`"value":${value}`);
      expect(text).not.toContain(`"value":"`); // a JSON number, not a string
      const decoded = decodeState(encoded);
      expect(decoded.slots[0].entry?.value).toBe(value);
      expect(stateWarnings(decoded)).toEqual([]);
    }
    expect(stateWarnings(emptyState())).toEqual([]);
  });

  it("decodes small wire numbers as bigints", () => {
    const raw = JSON.stringify({
      v: 2,
      contacts: { seq: 0, entries: [], sig: null },
      slots: emptyState().slots.map((slot, index) =>
        index === 0
          ? {
              seq: 1,
              entry: { value: 123456789, contact: CONTACT_A, unit: null, note: null },
              sig: SIG_A,
            }
          : slot,
      ),
    });
    expect(decodeState(raw).slots[0].entry?.value).toBe(123456789n);
  });
});
