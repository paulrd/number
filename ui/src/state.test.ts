import { describe, expect, it } from "vitest";
import {
  CENTS_MAX,
  CENTS_RANGE,
  I64_MAX,
  I64_MIN,
  LEGACY_STATE_VERSION,
  LIMITS,
  MAX_ADJUSTMENTS,
  MAX_ADJUSTMENT_NOTE_BYTES,
  MAX_CONTACTS,
  SLOT_COUNT,
  StateError,
  V4_STATE_VERSION,
  V5_STATE_VERSION,
  adjustmentsDigest16,
  adjustmentsSigningBytes,
  childNamesDigest16,
  childNamesSigningBytes,
  computeDelta,
  decodeDelta,
  decodeLegacyV5State,
  decodeState,
  decodeSummary,
  emptyAdjustments,
  emptyChildNames,
  emptyContacts,
  emptyParent,
  emptyPayments,
  emptySelfName,
  emptyState,
  encodeDelta,
  encodeState,
  encodeSummary,
  entryFromInputs,
  formatCents,
  isI64,
  mergeAdjustments,
  mergeChildNames,
  mergeDelta,
  mergeParent,
  mergePayments,
  mergeSelfName,
  mergeStates,
  optionalText,
  parentDigest16,
  parentSigningBytes,
  parseCents,
  paymentsDigest16,
  paymentsSigningBytes,
  selfNameDigest16,
  selfNameSigningBytes,
  signingBytes,
  slotDigest16,
  stateWarnings,
  summaryFromState,
  validateAdjustment,
  validateAdjustments,
  validateChildName,
  validateChildNames,
  validateContacts,
  validateDelta,
  validateEntry,
  validateLegacyV5State,
  validateParent,
  validatePaymentEntry,
  validatePayments,
  validateSelfName,
  validateState,
  validateSummary,
  type Adjustment,
  type Adjustments,
  type ChildName,
  type ChildNames,
  type Contact,
  type ContactsRecord,
  type Delta,
  type Entry,
  type ParentRecord,
  type SelfName,
  type Slot,
  type StateV3,
  type StateV5,
} from "./state";
import type { PaymentEntry, PaymentsRecord } from "./payments";
import { bytesToHex } from "./util";

const SIG_A = "a".repeat(128);
const SIG_B = "b".repeat(128);
const SIG_C = "c".repeat(128);

const CONTACT_A = "11".repeat(32);
const CONTACT_B = "22".repeat(32);
/** A userId with hex letters, for lowercase checks. */
const CONTACT_HEX = "ab".repeat(32);

// Spec §2.5 golden vectors (unchanged in v6).
const GOLDEN_SLOT_BYTES =
  "6e756d6265723a76323a736c6f74030700000000000000010c00000000000000" +
  "1111111111111111111111111111111111111111111111111111111111111111" +
  "0000000000000000";
const GOLDEN_SLOT_DIGEST16 = "d6f77f8b222a3ee76101db6e6f662e7c";

// DESIGN-v6.md §2: selfName, seq 1, "Alice".
const GOLDEN_SELF_NAME_BYTES =
  "6e756d6265723a76363a73656c666e616d65" + // "number:v6:selfname"
  "0100000000000000" + // seq 1
  "01" + // tag: named
  "05000000" + // length
  "416c696365"; // "Alice"
const GOLDEN_SELF_NAME_DIGEST16 = "f009ba5b61c81bcb865b6988ddecb79c";
const GOLDEN_SELF_NAME_CLEARED_BYTES =
  "6e756d6265723a76363a73656c666e616d65" + "0100000000000000" + "00";
const GOLDEN_SELF_NAME_CLEARED_DIGEST16 = "7d4cbb4f91a19c4a209f6d1ec1112cde";

// DESIGN-v6.md §3: childNames, seq 1, slot 0 -> Alice.
const GOLDEN_CHILD_NAMES_BYTES =
  "6e756d6265723a76363a6368696c646e616d6573" + // "number:v6:childnames"
  "0100000000000000" + // seq 1
  "01000000" + // count
  "00" + // slot 0
  CONTACT_A + // userId 0x11 * 32
  "05000000" + // name length
  "416c696365"; // "Alice"
const GOLDEN_CHILD_NAMES_DIGEST16 = "b51da0c87d76838cd5c83618eb93438c";

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

const PAY_USER_SRC = "11".repeat(32);
const PAY_USER_DST = "22".repeat(32);
const PAY_USER_NEXT = "33".repeat(32);
const PAYMENT_ID = "0123456789abcdef0123456789abcdef";
const PAY_LEG_SIG = "5a".repeat(64);
const SETTLED_A = "aa".repeat(16);
const SETTLED_B = "bb".repeat(16);

const GOLDEN_ADJUSTMENTS_BYTES =
  "6e756d6265723a76353a61646a7573746d656e7473" + // "number:v5:adjustments"
  "0100000000000000" + // seq 1
  "01000000" + // count
  "01" + // slot 1
  "0400000000000000" + // slotSeq 4
  "6400000000000000" + // delta +100
  "a60e000000000000" + // postValue 3750
  "05000000" + // note length
  "6973737565"; // "issue"
const GOLDEN_ADJUSTMENTS_DIGEST16 = "3ee15da20e9d1ce05d7478122818bf0e";

function payment(overrides: Partial<PaymentEntry> = {}): PaymentEntry {
  return {
    id: PAYMENT_ID,
    src: PAY_USER_SRC,
    dst: PAY_USER_DST,
    amount: 1250n,
    srcAddr: "52",
    dstAddr: "31",
    cursor: 2,
    phase: "forward",
    status: "acted",
    next: PAY_USER_NEXT,
    fail: null,
    legs: [{ slot: 1, seq: 4, postValue: 3750n, sig: PAY_LEG_SIG }],
    ...overrides,
  };
}

function payments(overrides: Partial<PaymentsRecord> = {}): PaymentsRecord {
  return { seq: 0, settled: [], entry: null, sig: null, ...overrides };
}

function adjustment(overrides: Partial<Adjustment> = {}): Adjustment {
  return {
    slot: 1,
    slotSeq: 4,
    delta: 100n,
    postValue: 3750n,
    note: "issue",
    ...overrides,
  };
}

function adjustments(overrides: Partial<Adjustments> = {}): Adjustments {
  return { seq: 0, entries: [], sig: null, ...overrides };
}

function selfName(overrides: Partial<SelfName> = {}): SelfName {
  return { seq: 0, name: null, sig: null, ...overrides };
}

function childNames(overrides: Partial<ChildNames> = {}): ChildNames {
  return { seq: 0, entries: [], sig: null, ...overrides };
}

function childName(overrides: Partial<ChildName> = {}): ChildName {
  return { slot: 0, userId: CONTACT_A, name: "Alice", ...overrides };
}

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
  self: SelfName = emptySelfName(),
  parent: ParentRecord = emptyParent(),
  children: ChildNames = emptyChildNames(),
): StateV3 {
  const state = emptyState();
  state.selfName = { ...self };
  state.parent = { ...parent };
  state.childNames = {
    seq: children.seq,
    entries: children.entries.map((item) => ({ ...item })),
    sig: children.sig,
  };
  state.payments = payments();
  state.adjustments = adjustments();
  for (const [index, slot] of Object.entries(slots)) {
    state.slots[Number(index)] = {
      seq: slot.seq,
      entry: slot.entry === null ? null : { ...slot.entry },
      sig: slot.sig,
    };
  }
  return state;
}

/** A raw v5 board with the given record overrides. */
function legacyRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = emptyState();
  return {
    v: V5_STATE_VERSION,
    parent: base.parent,
    contacts: contacts({
      seq: 1,
      entries: [contact("Alice")],
      sig: SIG_A,
    }),
    payments: base.payments,
    adjustments: base.adjustments,
    slots: base.slots,
    ...overrides,
  };
}

function delta(overrides: Record<string, unknown> = {}): Delta {
  return {
    v: 6,
    selfName: null,
    parent: null,
    childNames: null,
    payments: null,
    adjustments: null,
    slots: [],
    ...overrides,
  } as unknown as Delta;
}

describe("golden vectors", () => {
  it("builds the exact slot signing bytes and digest16", () => {
    expect(bytesToHex(signingBytes(3, 7, entry(12)))).toBe(GOLDEN_SLOT_BYTES);
    expect(slotDigest16(3, { seq: 7, entry: entry(12), sig: SIG_A })).toBe(
      GOLDEN_SLOT_DIGEST16,
    );
    expect(slotDigest16(3, { seq: 0, entry: null, sig: null })).toBe(
      "0".repeat(32),
    );
  });

  it("builds the exact selfName signing bytes, digest16 and cleared tag", () => {
    expect(bytesToHex(selfNameSigningBytes(1, "Alice"))).toBe(
      GOLDEN_SELF_NAME_BYTES,
    );
    expect(selfNameDigest16(selfName({ seq: 1, name: "Alice", sig: SIG_A }))).toBe(
      GOLDEN_SELF_NAME_DIGEST16,
    );
    expect(bytesToHex(selfNameSigningBytes(1, null))).toBe(
      GOLDEN_SELF_NAME_CLEARED_BYTES,
    );
    expect(selfNameDigest16(selfName({ seq: 1, name: null, sig: SIG_A }))).toBe(
      GOLDEN_SELF_NAME_CLEARED_DIGEST16,
    );
    expect(selfNameDigest16(emptySelfName())).toBe("0".repeat(32));
  });

  it("builds the exact childNames signing bytes and digest16", () => {
    const entries = [childName()];
    expect(bytesToHex(childNamesSigningBytes(1, entries))).toBe(
      GOLDEN_CHILD_NAMES_BYTES,
    );
    expect(childNamesDigest16(childNames({ seq: 1, entries, sig: SIG_A }))).toBe(
      GOLDEN_CHILD_NAMES_DIGEST16,
    );
    expect(childNamesDigest16(emptyChildNames())).toBe("0".repeat(32));
  });

  it("signs an empty childNames record at seq > 0 as count 0", () => {
    expect(bytesToHex(childNamesSigningBytes(4, []))).toBe(
      "6e756d6265723a76363a6368696c646e616d6573" +
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

  it("matches the contract lane's v5 adjustment golden vector", () => {
    const entries = [adjustment()];
    expect(bytesToHex(adjustmentsSigningBytes(1, entries))).toBe(
      GOLDEN_ADJUSTMENTS_BYTES,
    );
    expect(adjustmentsDigest16({ seq: 1, entries, sig: SIG_A })).toBe(
      GOLDEN_ADJUSTMENTS_DIGEST16,
    );
    expect(adjustmentsDigest16(emptyAdjustments())).toBe("0".repeat(32));
  });

  it("still signs a payments tombstone at seq > 0 with tag 0", () => {
    expect(bytesToHex(paymentsSigningBytes(3, [], null))).toBe(
      "6e756d6265723a76343a7061796d656e7473" +
        "0300000000000000" +
        "00" +
        "00",
    );
    expect(paymentsDigest16(emptyPayments())).toBe("0".repeat(32));
  });
});

describe("v6 state encode/decode", () => {
  it("round-trips the exact v6 shape with names and tombstones", () => {
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
      selfName({ seq: 2, name: "My board", sig: SIG_C }),
      { seq: 4, userId: CONTACT_B, sig: SIG_C },
      childNames({
        seq: 3,
        entries: [childName({ slot: 1, userId: CONTACT_B, name: "Child" })],
        sig: SIG_B,
      }),
    );

    const encoded = encodeState(state);
    expect(decodeState(encoded)).toEqual(state);

    const json = JSON.parse(new TextDecoder().decode(encoded));
    expect(json.v).toBe(6);
    expect(json.selfName).toEqual({
      seq: 2,
      name: "My board",
      sig: SIG_C,
    });
    expect(json.parent).toEqual({ seq: 4, userId: CONTACT_B, sig: SIG_C });
    expect(json.childNames).toEqual({
      seq: 3,
      entries: [{ slot: 1, userId: CONTACT_B, name: "Child" }],
      sig: SIG_B,
    });
    expect(json.payments).toEqual(emptyPayments());
    expect(json.adjustments).toEqual(emptyAdjustments());
    expect(json).not.toHaveProperty("contacts");
    expect(json.slots).toHaveLength(SLOT_COUNT);
    expect(json.slots[3]).toEqual({
      seq: 3,
      entry: { value: -42, contact: CONTACT_A, unit: "kg", note: "morning" },
      sig: SIG_A,
    });
    expect(json.slots[7]).toEqual({ seq: 1, entry: null, sig: SIG_B });
  });

  it("normalises absent value and empty optional strings", () => {
    const state = validateState({
      v: 6,
      selfName: emptySelfName(),
      parent: emptyParent(),
      childNames: emptyChildNames(),
      payments: emptyPayments(),
      adjustments: emptyAdjustments(),
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

  it("round-trips a v6 delta and summary with both name records", () => {
    const next = {
      v: 6 as const,
      selfName: selfName({ seq: 2, name: "Renamed", sig: SIG_C }),
      parent: null,
      childNames: childNames({
        seq: 2,
        entries: [childName({ slot: 2, userId: CONTACT_B, name: "Bob" })],
        sig: SIG_C,
      }),
      payments: null,
      adjustments: null,
      slots: [
        { i: 2, seq: 4, entry: entry(8, { unit: "kg" }), sig: SIG_C },
        { i: 5, seq: 9, entry: null, sig: SIG_A },
      ],
    };
    expect(decodeDelta(encodeDelta(next))).toEqual(next);

    const summary = summaryFromState(
      stateWith(
        { 3: { seq: 7, entry: entry(12), sig: SIG_A } },
        selfName({ seq: 1, name: "Alice", sig: SIG_B }),
        emptyParent(),
        childNames({
          seq: 1,
          entries: [childName()],
          sig: SIG_B,
        }),
      ),
    );
    expect(decodeSummary(encodeSummary(summary))).toEqual(summary);
    expect(summary.v).toBe(6);
    expect(summary.parent).toEqual([0, "0".repeat(32)]);
    expect(summary.selfName).toEqual([1, GOLDEN_SELF_NAME_DIGEST16]);
    expect(summary.childNames).toEqual([1, GOLDEN_CHILD_NAMES_DIGEST16]);
    expect(summary.payments).toEqual([0, "0".repeat(32)]);
    expect(summary.adjustments).toEqual([0, "0".repeat(32)]);
    expect(summary.slots).toHaveLength(SLOT_COUNT);
    expect(summary.slots[0]).toEqual([0, "0".repeat(32)]);
    expect(summary.slots[3][1]).toBe(GOLDEN_SLOT_DIGEST16);
  });

  it("accepts an absent or null delta name/parent record", () => {
    for (const raw of [
      { v: 6, slots: [] },
      delta({ selfName: null, parent: null, childNames: null }),
    ]) {
      const decoded = validateDelta(raw);
      expect(decoded.selfName).toBeNull();
      expect(decoded.parent).toBeNull();
      expect(decoded.childNames).toBeNull();
      expect(decoded.payments).toBeNull();
    }
  });

  it("rejects malformed JSON and impossible v6 shapes", () => {
    expect(() => decodeState("{not json")).toThrow(StateError);
    expect(() => validateState({ v: 1, contacts: emptyContacts(), slots: [] })).toThrow(
      /state\.v/,
    );
    expect(() =>
      validateState({
        v: 6,
        selfName: emptySelfName(),
        parent: emptyParent(),
        childNames: emptyChildNames(),
        payments: emptyPayments(),
        adjustments: emptyAdjustments(),
        slots: emptyState().slots.slice(0, 7),
      }),
    ).toThrow(/exactly 8/);
    expect(() =>
      validateState({
        v: 6,
        selfName: emptySelfName(),
        parent: emptyParent(),
        childNames: emptyChildNames(),
        contacts: emptyContacts(),
        payments: emptyPayments(),
        adjustments: emptyAdjustments(),
        slots: emptyState().slots,
      }),
    ).toThrow(/must not carry a contacts record/);
    expect(() =>
      validateState({
        v: 6,
        parent: emptyParent(),
        childNames: emptyChildNames(),
        payments: emptyPayments(),
        adjustments: emptyAdjustments(),
        slots: emptyState().slots,
      }),
    ).toThrow(/state\.selfName/);
    expect(() =>
      validateDelta(
        delta({
          slots: [
            { i: 1, seq: 1, entry: entry(1), sig: SIG_A },
            { i: 1, seq: 2, entry: entry(2), sig: SIG_B },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      validateDelta(delta({ contacts: emptyContacts() })),
    ).toThrow(/must not carry a contacts record/);
    expect(() =>
      validateSummary({
        v: 6,
        parent: [0, "0".repeat(32)],
        selfName: [0, "0".repeat(32)],
        childNames: [0, "0".repeat(32)],
        payments: [0, "0".repeat(32)],
        adjustments: [0, "0".repeat(32)],
        slots: [],
      }),
    ).toThrow(/exactly 8/);
  });
});

describe("legacy upgrade and v5 reader", () => {
  it("upgrades v2/v3/v4/v5 to v6 and drops the address book", () => {
    for (const raw of [
      {
        v: LEGACY_STATE_VERSION,
        contacts: contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A }),
        slots: emptyState().slots,
      },
      {
        v: 3,
        parent: { seq: 2, userId: CONTACT_B, sig: SIG_A },
        contacts: contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A }),
        slots: emptyState().slots,
      },
      {
        v: V4_STATE_VERSION,
        parent: { seq: 2, userId: CONTACT_B, sig: SIG_A },
        contacts: contacts({ seq: 1, entries: [contact("Alice")], sig: SIG_A }),
        payments: payments({ seq: 1, entry: payment(), sig: SIG_B }),
        slots: emptyState().slots,
      },
      legacyRaw(),
    ]) {
      const upgraded = validateState(raw);
      expect(upgraded.v).toBe(6);
      expect(upgraded.selfName).toEqual(emptySelfName());
      expect(upgraded.childNames).toEqual(emptyChildNames());
      expect(upgraded).not.toHaveProperty("contacts");

      const json = JSON.parse(new TextDecoder().decode(encodeState(upgraded)));
      expect(json.v).toBe(6);
      expect(json).not.toHaveProperty("contacts");
      expect(json.selfName).toEqual({ seq: 0, name: null, sig: null });
      expect(json.childNames).toEqual({ seq: 0, entries: [], sig: null });
    }
  });

  it("keeps v5 contacts and the self-entry in the legacy reader", () => {
    const raw = legacyRaw();
    const legacy: StateV5 = validateLegacyV5State(raw);
    expect(legacy.v).toBe(5);
    expect(legacy.contacts).toEqual(raw.contacts);

    const decoded = decodeLegacyV5State(JSON.stringify(raw));
    expect(decoded).toEqual(legacy);
    expect(decoded.contacts.entries).toEqual([contact("Alice")]);
  });

  it("validates the legacy contacts array exactly like v5", () => {
    expect(() =>
      validateLegacyV5State(legacyRaw({ contacts: contacts({ seq: 1, entries: [], sig: null }) })),
    ).toThrow(/requires a signature/);
    expect(() =>
      validateLegacyV5State(
        legacyRaw({
          contacts: contacts({
            seq: 1,
            entries: [contact("Alice"), contact("Bob", CONTACT_A)],
            sig: SIG_A,
          }),
        }),
      ),
    ).toThrow(/duplicate userId/);
    expect(() => validateLegacyV5State({ ...legacyRaw(), v: 6 })).toThrow(
      /expected a pre-v6 state/,
    );
  });

  it("rejects name records on a pre-v6 state", () => {
    expect(() =>
      validateState(legacyRaw({ selfName: emptySelfName() })),
    ).toThrow(/must not carry a selfName/);
    expect(() =>
      validateState(legacyRaw({ childNames: emptyChildNames() })),
    ).toThrow(/must not carry a childNames/);
  });
});

describe("selfName validation", () => {
  it("accepts the empty record, a name and a cleared tombstone", () => {
    expect(validateSelfName({ seq: 0, name: null, sig: null })).toEqual(
      emptySelfName(),
    );
    expect(validateSelfName({ seq: 2, name: "Alice", sig: SIG_A })).toEqual({
      seq: 2,
      name: "Alice",
      sig: SIG_A,
    });
    expect(validateSelfName({ seq: 2, name: null, sig: SIG_A })).toEqual({
      seq: 2,
      name: null,
      sig: SIG_A,
    });
  });

  it("rejects impossible seq/name/sig combinations", () => {
    expect(() => validateSelfName({ seq: 0, name: "Alice", sig: null })).toThrow(
      /seq 0 must have a null name/,
    );
    expect(() => validateSelfName({ seq: 0, name: null, sig: SIG_A })).toThrow(
      /seq 0 must have a null signature/,
    );
    expect(() => validateSelfName({ seq: 1, name: "Alice", sig: null })).toThrow(
      /requires a signature/,
    );
    expect(() => validateSelfName({ seq: 1, name: "", sig: SIG_A })).toThrow(
      /must not be empty/,
    );
    expect(() =>
      validateSelfName({ seq: 1, name: "a".repeat(LIMITS.label + 1), sig: SIG_A }),
    ).toThrow(/64-byte limit/);
    expect(() => validateSelfName({ seq: 1, name: "Alice", sig: "A".repeat(128) })).toThrow(
      /lowercase hex/,
    );
    expect(() => validateSelfName(null)).toThrow(/expected an object/);
  });
});

describe("childNames validation", () => {
  it("accepts a legal ascending record and preserves order", () => {
    const record = validateChildNames({
      seq: 3,
      entries: [
        { slot: 0, userId: CONTACT_B, name: "Bob" },
        { slot: 2, userId: CONTACT_A, name: "Alice" },
      ],
      sig: SIG_A,
    });
    expect(record.entries.map((item) => item.name)).toEqual(["Bob", "Alice"]);
    expect(validateChildName(childName())).toEqual(childName());
  });

  it("enforces bounds, ascending unique slots and the userId shape", () => {
    expect(() =>
      validateChildNames(childNames({ seq: 1, entries: [childName({ slot: 8 })], sig: SIG_A })),
    ).toThrow(/slot/);
    expect(() =>
      validateChildNames(
        childNames({
          seq: 1,
          entries: [childName({ slot: 1 }), childName({ slot: 0 })],
          sig: SIG_A,
        }),
      ),
    ).toThrow(/strictly ascending/);
    expect(() =>
      validateChildNames(
        childNames({
          seq: 1,
          entries: [childName({ slot: 1 }), childName({ slot: 1 })],
          sig: SIG_A,
        }),
      ),
    ).toThrow(/strictly ascending/);
    expect(() =>
      validateChildNames(
        childNames({
          seq: 1,
          entries: [childName({ userId: CONTACT_HEX.toUpperCase() })],
          sig: SIG_A,
        }),
      ),
    ).toThrow(/userId/);
    expect(() =>
      validateChildNames(
        childNames({ seq: 1, entries: [childName({ name: "" })], sig: SIG_A }),
      ),
    ).toThrow(/must not be empty/);
    expect(() =>
      validateChildNames(
        childNames({
          seq: 1,
          entries: [childName({ name: "a".repeat(LIMITS.label + 1) })],
          sig: SIG_A,
        }),
      ),
    ).toThrow(/64-byte limit/);
    const tooMany = Array.from({ length: SLOT_COUNT + 1 }, (_, index) =>
      childName({ slot: index }),
    );
    expect(() =>
      validateChildNames(childNames({ seq: 1, entries: tooMany, sig: SIG_A })),
    ).toThrow(/at most 8/);
  });

  it("enforces the seq/sig invariants and allows an empty tombstone", () => {
    expect(() =>
      validateChildNames(childNames({ seq: 0, entries: [childName()], sig: null })),
    ).toThrow(/seq 0 must have no entries/);
    expect(() =>
      validateChildNames(childNames({ seq: 0, entries: [], sig: SIG_A })),
    ).toThrow(/seq 0 must have a null signature/);
    expect(() =>
      validateChildNames(childNames({ seq: 1, entries: [], sig: null })),
    ).toThrow(/requires a signature/);
    expect(
      validateChildNames(childNames({ seq: 9, entries: [], sig: SIG_A })),
    ).toEqual({ seq: 9, entries: [], sig: SIG_A });
  });
});

describe("parent codec", () => {
  it("accepts a root, a set parent and a cleared parent", () => {
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
    expect(() => validateParent({ seq: 0, userId: CONTACT_A, sig: null })).toThrow(
      /seq 0 must have a null userId/,
    );
    expect(() => validateParent({ seq: 0, userId: null, sig: SIG_A })).toThrow(
      /seq 0 must have a null signature/,
    );
    expect(() => validateParent({ seq: 1, userId: CONTACT_A, sig: null })).toThrow(
      /requires a signature/,
    );
    expect(() =>
      validateParent({ seq: 1, userId: "AB".repeat(32), sig: SIG_A }),
    ).toThrow(/userId/);
    expect(() =>
      validateParent({ seq: 1, userId: CONTACT_A, sig: "A".repeat(128) }),
    ).toThrow(/lowercase hex/);
    expect(() => validateParent(null)).toThrow(/expected an object/);
  });
});

describe("parent in state, delta, summary and merge", () => {
  it("round-trips a v6 state with a parent", () => {
    const state = stateWith(
      { 0: { seq: 1, entry: entry(5), sig: SIG_A } },
      emptySelfName(),
      { seq: 4, userId: CONTACT_B, sig: SIG_C },
    );
    const encoded = encodeState(state);
    const json = JSON.parse(new TextDecoder().decode(encoded));
    expect(json.parent).toEqual({ seq: 4, userId: CONTACT_B, sig: SIG_C });
    expect(decodeState(encoded)).toEqual(state);
  });

  it("includes the parent pair in the summary and computeDelta", () => {
    const summary = summaryFromState(
      stateWith({}, emptySelfName(), {
        seq: 1,
        userId: PARENT_USER,
        sig: SIG_A,
      }),
    );
    expect(summary.parent).toEqual([1, GOLDEN_PARENT_DIGEST16]);

    const ours = stateWith({}, emptySelfName(), {
      seq: 2,
      userId: CONTACT_B,
      sig: SIG_B,
    });
    const theirs = stateWith({}, emptySelfName(), {
      seq: 1,
      userId: CONTACT_A,
      sig: SIG_A,
    });
    expect(computeDelta(ours, theirs).parent).toEqual(ours.parent);
    expect(computeDelta(theirs, ours).parent).toBeNull();
    expect(computeDelta(ours, ours).parent).toBeNull();
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

    const cleared = { seq: 3, userId: null, sig: SIG_C };
    expect(mergeParent(tieHigh, cleared)).toEqual(cleared);
    expect(mergeParent(cleared, tieHigh)).toEqual(cleared);
  });
});

describe("entry validation and cents helpers", () => {
  it("requires a valid contact and i64 value", () => {
    expect(() => validateEntry({ value: 1, contact: CONTACT_A })).not.toThrow();
    expect(() =>
      validateEntry({ value: 1, contact: CONTACT_HEX.toUpperCase() }),
    ).toThrow(/contact/);
    expect(() => validateEntry({ value: 1 })).toThrow(/contact/);
    expect(() =>
      validateEntry({ contact: CONTACT_A, unit: "u".repeat(17) }),
    ).toThrow(/16-byte limit/);
    expect(() =>
      validateEntry({ contact: CONTACT_A, note: "n".repeat(513) }),
    ).toThrow(/512-byte limit/);
    expect(() => validateEntry({ value: 1.5, contact: CONTACT_A })).toThrow(
      /integer/,
    );
    expect(() =>
      validateEntry({ value: 2 ** 63, contact: CONTACT_A }),
    ).toThrow(/exact integer/);
    expect(() =>
      validateEntry({ value: I64_MAX + 1n, contact: CONTACT_A }),
    ).toThrow(/signed 64-bit/);
  });

  it("builds entries from form inputs", () => {
    expect(
      entryFromInputs(1250n, ` ${CONTACT_A.toUpperCase()} `, " kg ", " "),
    ).toEqual({
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
    for (const input of ["1e3", "1.234", "1,000", "1 2", "--1", "+-1", "1.2.3", "abc", ".", "+"]) {
      expect(() => parseCents(input)).toThrow(StateError);
    }
    expect(() => parseCents("1.234")).toThrow(/at most 2 decimal places/);
    expect(() => parseCents("abc")).toThrow(/amount/i);
  });

  it("covers the exact i64 cents boundary", () => {
    expect(parseCents(CENTS_MAX)).toBe(I64_MAX);
    expect(parseCents(CENTS_RANGE)).toBe(I64_MIN);
    expect(() => parseCents("92233720368547758.08")).toThrow(/between/);
    expect(() => parseCents("99999999999999999999")).toThrow(/between/);
    expect(formatCents(0n)).toBe("0.00");
    expect(formatCents(1250n)).toBe("12.50");
    expect(formatCents(-1250n)).toBe("-12.50");
    for (const value of [0n, 1n, -1n, 1250n, -987654321n, I64_MIN, I64_MAX]) {
      expect(parseCents(formatCents(value))).toBe(value);
    }
    expect(isI64(I64_MAX)).toBe(true);
    expect(isI64(I64_MAX + 1n)).toBe(false);
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

  it("merges selfName by seq then signature bytes", () => {
    const low = selfName({ seq: 1, name: "Old", sig: SIG_A });
    const high = selfName({ seq: 2, name: "New", sig: SIG_A });
    expect(mergeSelfName(low, high)).toEqual(high);
    expect(mergeSelfName(high, low)).toEqual(high);

    const tieA = selfName({ seq: 3, name: "A", sig: SIG_A });
    const tieB = selfName({ seq: 3, name: "B", sig: SIG_B });
    expect(mergeSelfName(tieA, tieB)).toEqual(tieB);
    expect(mergeSelfName(tieB, tieA)).toEqual(tieB);

    const cleared = selfName({ seq: 4, name: null, sig: SIG_C });
    expect(mergeSelfName(tieB, cleared)).toEqual(cleared);
    expect(mergeSelfName(cleared, tieB)).toEqual(cleared);
  });

  it("merges childNames as a whole record", () => {
    const low = childNames({
      seq: 1,
      entries: [childName({ name: "Old" })],
      sig: SIG_A,
    });
    const high = childNames({
      seq: 2,
      entries: [childName({ slot: 2, userId: CONTACT_B, name: "New" })],
      sig: SIG_A,
    });
    expect(mergeChildNames(low, high)).toEqual(high);
    expect(mergeChildNames(high, low)).toEqual(high);

    const tieA = childNames({ seq: 3, entries: [childName({ name: "A" })], sig: SIG_A });
    const tieB = childNames({ seq: 3, entries: [childName({ name: "B" })], sig: SIG_B });
    expect(mergeChildNames(tieA, tieB)).toEqual(tieB);
    expect(mergeChildNames(tieB, tieA)).toEqual(tieB);
  });

  it("keeps every record independent in a full merge", () => {
    const a = stateWith(
      { 0: { seq: 1, entry: entry(1), sig: SIG_A } },
      selfName({ seq: 1, name: "Self A", sig: SIG_A }),
      emptyParent(),
      childNames({ seq: 1, entries: [childName()], sig: SIG_A }),
    );
    const b = stateWith(
      { 0: { seq: 2, entry: entry(2), sig: SIG_B } },
      selfName({ seq: 2, name: "Self B", sig: SIG_B }),
      emptyParent(),
      childNames({ seq: 2, entries: [], sig: SIG_B }),
    );
    const merged = mergeStates(a, b);
    expect(merged.slots[0]).toEqual(b.slots[0]);
    expect(merged.selfName).toEqual(b.selfName);
    expect(merged.childNames).toEqual(b.childNames);
  });

  it("applies name-only deltas and lets stale records lose", () => {
    const base = stateWith({}, selfName({ seq: 1, name: "Old", sig: SIG_A }));
    const newer = delta({
      selfName: selfName({ seq: 2, name: "New", sig: SIG_B }),
      childNames: childNames({
        seq: 1,
        entries: [childName()],
        sig: SIG_B,
      }),
    });
    const next = mergeDelta(base, newer);
    expect(next.selfName).toEqual(newer.selfName);
    expect(next.childNames.entries).toEqual([childName()]);

    const stale = delta({
      selfName: selfName({ seq: 1, name: "Stale", sig: SIG_C }),
      childNames: childNames({ seq: 0, entries: [], sig: null }),
    });
    expect(mergeDelta(next, stale).selfName).toEqual(next.selfName);
    expect(mergeDelta(next, stale).childNames).toEqual(next.childNames);
  });

  it("treats a repeated delta as a no-op and lets stale slots lose", () => {
    const base = stateWith({ 0: { seq: 2, entry: entry(2), sig: SIG_B } });
    const stale = delta({
      slots: [{ i: 0, seq: 1, entry: entry(1), sig: SIG_A }],
    });
    expect(mergeDelta(base, stale)).toEqual(base);

    const fresh = delta({
      slots: [{ i: 0, seq: 3, entry: entry(3), sig: SIG_C }],
    });
    const once = mergeDelta(base, fresh);
    expect(mergeDelta(once, fresh)).toEqual(once);
  });
});

describe("delta filtering", () => {
  it("returns a literally empty delta when converged", () => {
    const state = stateWith(
      { 2: { seq: 4, entry: entry(8), sig: SIG_A } },
      selfName({ seq: 2, name: "Alice", sig: SIG_C }),
      emptyParent(),
      childNames({ seq: 1, entries: [childName()], sig: SIG_B }),
    );
    const empty = {
      v: 6,
      selfName: null,
      parent: null,
      childNames: null,
      payments: null,
      adjustments: null,
      slots: [],
    };
    expect(computeDelta(state, state)).toEqual(empty);
    expect(
      JSON.parse(new TextDecoder().decode(encodeDelta(computeDelta(state, state)))),
    ).toEqual(empty);
  });

  it("includes newer name records and leaves stale ones null", () => {
    const theirs = stateWith({}, emptySelfName());
    const ours = stateWith(
      {},
      selfName({ seq: 2, name: "Alice", sig: SIG_B }),
      emptyParent(),
      childNames({ seq: 1, entries: [childName()], sig: SIG_B }),
    );
    const forward = computeDelta(ours, theirs);
    expect(forward.selfName).toEqual(ours.selfName);
    expect(forward.childNames).toEqual(ours.childNames);
    expect(computeDelta(theirs, ours).selfName).toBeNull();
    expect(computeDelta(theirs, ours).childNames).toBeNull();
  });

  it("includes name records at equal seq when digests diverge", () => {
    const a = stateWith(
      {},
      selfName({ seq: 2, name: "Alice", sig: SIG_A }),
      emptyParent(),
      childNames({ seq: 2, entries: [childName({ name: "A" })], sig: SIG_A }),
    );
    const b = stateWith(
      {},
      selfName({ seq: 2, name: "Bob", sig: SIG_B }),
      emptyParent(),
      childNames({ seq: 2, entries: [childName({ name: "B" })], sig: SIG_B }),
    );
    const next = computeDelta(a, b);
    expect(next.selfName).toEqual(a.selfName);
    expect(next.childNames).toEqual(a.childNames);
    expect(next.slots).toEqual([]);
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
    const next = computeDelta(ours, theirs);
    expect(next.slots.map((slot) => slot.i)).toEqual([0, 1]);
    expect(next.slots[0]).toMatchObject({ i: 0, seq: 3 });
    expect(next.slots[1]).toMatchObject({ i: 1, seq: 2 });
  });

  it("ignores empty slots and includes tombstones with seq > 0", () => {
    const ours = stateWith({
      0: { seq: 0, entry: null, sig: null },
      5: { seq: 6, entry: null, sig: SIG_A },
    });
    expect(computeDelta(ours, emptyState()).slots).toEqual([
      { i: 5, seq: 6, entry: null, sig: SIG_A },
    ]);
  });
});

describe("payments and adjustments records", () => {
  it("round-trips payments in state, delta and summary", () => {
    const record = payments({ seq: 6, entry: payment(), sig: SIG_A });
    const state = stateWith({});
    state.payments = record;
    expect(decodeState(encodeState(state)).payments).toEqual(record);

    const next = delta({ payments: record });
    expect(decodeDelta(encodeDelta(next)).payments).toEqual(record);
    expect(mergeDelta(emptyState(), next).payments).toEqual(record);

    const summary = summaryFromState(state);
    expect(summary.payments[0]).toBe(6);
    expect(decodeSummary(encodeSummary(summary)).payments).toEqual(
      summary.payments,
    );
  });

  it("carries settled ids through state, delta and summary", () => {
    const record = payments({
      seq: 6,
      settled: [SETTLED_A, SETTLED_B],
      entry: payment(),
      sig: SIG_A,
    });
    const state = stateWith({});
    state.payments = record;
    expect(decodeState(encodeState(state)).payments).toEqual(record);
    expect(paymentsDigest16(record)).toBe(summaryFromState(state).payments[1]);
  });

  it("round-trips adjustments and merges by seq then signature", () => {
    const record = adjustments({
      seq: 6,
      entries: [adjustment()],
      sig: SIG_A,
    });
    const state = stateWith({});
    state.adjustments = record;
    expect(decodeState(encodeState(state)).adjustments).toEqual(record);
    expect(adjustmentsDigest16(record)).toBe(summaryFromState(state).adjustments[1]);

    const higher = adjustments({
      seq: 7,
      entries: [],
      sig: SIG_B,
    });
    expect(mergeAdjustments(record, higher)).toEqual(higher);
    expect(mergeAdjustments(higher, record)).toEqual(higher);
  });

  it("validates payments and adjustments bounds", () => {
    expect(() =>
      validatePayments({ seq: 1, settled: [], entry: null, sig: null }),
    ).toThrow(/requires a signature/);
    expect(() =>
      validatePayments({ seq: 0, settled: [SETTLED_A], entry: null, sig: null }),
    ).toThrow(/no settled ids/);
    expect(() =>
      validateAdjustments({
        seq: 1,
        entries: [adjustment({ slot: 8 })],
        sig: SIG_A,
      }),
    ).toThrow(/slot/);
    expect(() =>
      validateAdjustments({
        seq: 1,
        entries: [adjustment({ note: "n".repeat(MAX_ADJUSTMENT_NOTE_BYTES + 1) })],
        sig: SIG_A,
      }),
    ).toThrow(/note/);
    expect(() =>
      validateAdjustments({
        seq: 1,
        entries: Array.from({ length: MAX_ADJUSTMENTS + 1 }, (_, index) =>
          adjustment({ slotSeq: index + 1 }),
        ),
        sig: SIG_A,
      }),
    ).toThrow(/at most 32/);
    expect(validateAdjustment(adjustment())).toEqual(adjustment());
    expect(validatePaymentEntry(payment())).toEqual(payment());
    expect(mergePayments(payments(), payments({ seq: 1, sig: SIG_A }))).toEqual(
      payments({ seq: 1, sig: SIG_A }),
    );
  });

  it("rejects a v2 contact count above the legacy bound", () => {
    const many = Array.from({ length: MAX_CONTACTS + 1 }, (_, index) => ({
      label: `c${index}`,
      userId: index.toString(16).padStart(64, "0"),
    }));
    expect(() => validateContacts(contacts({ seq: 1, entries: many, sig: SIG_A })))
      .toThrow(new RegExp(`at most ${MAX_CONTACTS}`));
  });
});

describe("state warnings", () => {
  it("has no advisories for a valid state", () => {
    expect(stateWarnings(emptyState())).toEqual([]);
  });
});
