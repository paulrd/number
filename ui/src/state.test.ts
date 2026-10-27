import { describe, expect, it } from "vitest";
import {
  I64_MAX,
  I64_MIN,
  LIMITS,
  StateError,
  computeDelta,
  decodeDelta,
  decodeState,
  decodeSummary,
  emptyState,
  encodeDelta,
  encodeState,
  encodeSummary,
  isI64,
  mergeDelta,
  mergeStates,
  optionalText,
  signingBytes,
  slotDigest16,
  stateWarnings,
  summaryFromState,
  validateDelta,
  validateEntry,
  validateState,
  validateSummary,
  type Entry,
  type Slot,
  type StateV1,
} from "./state";
import { bytesToHex } from "./util";

const SIG_A = "a".repeat(128);
const SIG_B = "b".repeat(128);
const SIG_C = "c".repeat(128);

function entry(value: number | bigint, overrides: Partial<Entry> = {}): Entry {
  return {
    value: typeof value === "bigint" ? value : BigInt(value),
    label: null,
    unit: null,
    note: null,
    ...overrides,
  };
}

function stateWith(slots: Record<number, Slot>): StateV1 {
  const state = emptyState();
  for (const [index, slot] of Object.entries(slots)) {
    state.slots[Number(index)] = {
      seq: slot.seq,
      entry: slot.entry === null ? null : { ...slot.entry },
      sig: slot.sig,
    };
  }
  return state;
}

describe("state encode/decode", () => {
  it("round-trips the exact state shape, including tombstones", () => {
    const state = stateWith({
      0: { seq: 0, entry: null, sig: null },
      3: {
        seq: 3,
        entry: entry(-42, { label: "weight", unit: "kg", note: "morning" }),
        sig: SIG_A,
      },
      7: { seq: 1, entry: null, sig: SIG_B },
    });

    const encoded = encodeState(state);
    expect(decodeState(encoded)).toEqual(state);

    const json = JSON.parse(new TextDecoder().decode(encoded));
    expect(json).toEqual({
      v: 1,
      slots: [
        { seq: 0, entry: null, sig: null },
        { seq: 0, entry: null, sig: null },
        { seq: 0, entry: null, sig: null },
        {
          seq: 3,
          entry: { value: -42, label: "weight", unit: "kg", note: "morning" },
          sig: SIG_A,
        },
        { seq: 0, entry: null, sig: null },
        { seq: 0, entry: null, sig: null },
        { seq: 0, entry: null, sig: null },
        { seq: 1, entry: null, sig: SIG_B },
      ],
    });
  });

  it("normalises absent and empty optional strings to null", () => {
    const state = validateState({
      v: 1,
      slots: emptyState().slots.map((slot, index) => {
        if (index === 2) {
          return { seq: 1, entry: { value: 7 }, sig: SIG_A };
        }
        if (index === 3) {
          return {
            seq: 1,
            entry: { value: 8, label: "", unit: "", note: "" },
            sig: SIG_B,
          };
        }
        return slot;
      }),
    });

    expect(state.slots[2].entry).toEqual({
      value: 7n,
      label: null,
      unit: null,
      note: null,
    });
    expect(state.slots[3].entry).toEqual({
      value: 8n,
      label: null,
      unit: null,
      note: null,
    });
    expect(optionalText("  ")).toBeNull();
    expect(optionalText("  kg ")).toBe("kg");
  });

  it("round-trips delta and summary encodings", () => {
    const delta = {
      v: 1 as const,
      slots: [
        { i: 2, seq: 4, entry: entry(8, { label: "steps" }), sig: SIG_C },
        { i: 5, seq: 9, entry: null, sig: SIG_A },
      ],
    };
    expect(decodeDelta(encodeDelta(delta))).toEqual(delta);

    const state = stateWith({
      3: { seq: 7, entry: entry(12), sig: SIG_A },
    });
    const summary = summaryFromState(state);
    expect(decodeSummary(encodeSummary(summary))).toEqual(summary);
    expect(summary.slots).toHaveLength(8);
    expect(summary.slots[0]).toEqual([0, "0".repeat(32)]);
    expect(summary.slots[3][1]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("locks the canonical signing bytes and digest formula", () => {
    // DESIGN §2 golden shape for slot 3, seq 7, value 12, no strings.
    expect(bytesToHex(signingBytes(3, 7, entry(12)))).toBe(
      "6e756d6265723a76313a736c6f74030700000000000000010c00000000000000000000000000000000000000",
    );
    expect(
      slotDigest16(3, { seq: 7, entry: entry(12), sig: SIG_A }),
    ).toBe("eb7ac2d711346270d4e9894b538fb281");
    expect(slotDigest16(3, { seq: 0, entry: null, sig: null })).toBe(
      "0".repeat(32),
    );
  });

  it("rejects malformed JSON/state/delta/summary", () => {
    expect(() => decodeState("{not json")).toThrow(StateError);
    expect(() => validateState({ v: 2, slots: emptyState().slots })).toThrow(
      /state\.v/,
    );
    expect(() =>
      validateState({ v: 1, slots: emptyState().slots.slice(0, 7) }),
    ).toThrow(/exactly 8/);
    expect(() =>
      validateDelta({
        v: 1,
        slots: [
          { i: 1, seq: 1, entry: entry(1), sig: SIG_A },
          { i: 1, seq: 2, entry: entry(2), sig: SIG_B },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => validateSummary({ v: 1, slots: [] })).toThrow(/exactly 8/);
  });
});

describe("merge determinism", () => {
  it("is commutative and idempotent for different seqs", () => {
    const low = stateWith({ 0: { seq: 1, entry: entry(1), sig: SIG_A } });
    const high = stateWith({ 0: { seq: 2, entry: entry(2), sig: SIG_A } });

    expect(mergeStates(low, high)).toEqual(high);
    expect(mergeStates(high, low)).toEqual(high);
    expect(mergeStates(high, high)).toEqual(high);
  });

  it("breaks equal-seq ties on signature bytes, symmetrically", () => {
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

  it("treats a repeated delta as a no-op and lets stale deltas lose", () => {
    const base = stateWith({ 0: { seq: 2, entry: entry(2), sig: SIG_B } });
    const stale = {
      v: 1 as const,
      slots: [{ i: 0, seq: 1, entry: entry(1), sig: SIG_A }],
    };
    expect(mergeDelta(base, stale)).toEqual(base);

    const fresh = {
      v: 1 as const,
      slots: [{ i: 0, seq: 3, entry: entry(3), sig: SIG_C }],
    };
    const once = mergeDelta(base, fresh);
    expect(mergeDelta(once, fresh)).toEqual(once);
  });
});

describe("delta filtering", () => {
  it("returns a literally empty delta when converged", () => {
    const state = stateWith({
      2: { seq: 4, entry: entry(8), sig: SIG_A },
      7: { seq: 1, entry: null, sig: SIG_B },
    });
    expect(computeDelta(state, state)).toEqual({ v: 1, slots: [] });
    expect(
      JSON.parse(new TextDecoder().decode(encodeDelta(computeDelta(state, state)))),
    ).toEqual({ v: 1, slots: [] });
  });

  it("includes newer seqs and equal-seq digest divergence, not stale slots", () => {
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
  it("enforces the UTF-8 byte limits", () => {
    expect(() =>
      validateEntry(entry(1, { label: "a".repeat(LIMITS.label) })),
    ).not.toThrow();
    expect(() =>
      validateEntry(entry(1, { label: "a".repeat(LIMITS.label + 1) })),
    ).toThrow(/64-byte limit/);

    expect(() => validateEntry(entry(1, { unit: "u".repeat(16) }))).not.toThrow();
    expect(() => validateEntry(entry(1, { unit: "u".repeat(17) }))).toThrow(
      /16-byte limit/,
    );

    expect(() => validateEntry(entry(1, { note: "n".repeat(512) }))).not.toThrow();
    expect(() => validateEntry(entry(1, { note: "n".repeat(513) }))).toThrow(
      /512-byte limit/,
    );

    // "é" is 2 bytes in UTF-8: 32 chars = 64 bytes, 33 chars = 66 bytes.
    expect(() => validateEntry(entry(1, { label: "é".repeat(32) }))).not.toThrow();
    expect(() => validateEntry(entry(1, { label: "é".repeat(33) }))).toThrow(
      /64-byte limit/,
    );
  });

  it("requires integer i64 values", () => {
    expect(isI64(-42)).toBe(true);
    expect(isI64(Number(I64_MIN))).toBe(true);
    expect(isI64(2 ** 63)).toBe(false);
    expect(() => validateEntry({ value: 1.5 })).toThrow(/integer/);
    expect(() => validateEntry({ value: "1" })).toThrow(/integer/);
    expect(() => validateEntry(entry(2 ** 63))).toThrow(/signed 64-bit/);
  });

  it("enforces seq-0 and signature invariants atomically", () => {
    expect(() =>
      validateState({
        v: 1,
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 0, entry: entry(1), sig: null } : slot,
        ),
      }),
    ).toThrow(/seq 0 must have a null entry/);

    expect(() =>
      validateState({
        v: 1,
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 0, entry: null, sig: SIG_A } : slot,
        ),
      }),
    ).toThrow(/seq 0 must have a null signature/);

    expect(() =>
      validateState({
        v: 1,
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 1, entry: entry(1), sig: null } : slot,
        ),
      }),
    ).toThrow(/requires a signature/);

    expect(() =>
      validateState({
        v: 1,
        slots: emptyState().slots.map((slot, index) =>
          index === 0 ? { seq: 1, entry: entry(1), sig: "A".repeat(128) } : slot,
        ),
      }),
    ).toThrow(/lowercase hex/);

    expect(() =>
      validateDelta({
        v: 1,
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

  it("decodes a legacy state with small numbers as bigints", () => {
    const legacy = JSON.stringify({
      v: 1,
      slots: emptyState().slots.map((slot, index) =>
        index === 0
          ? {
              seq: 1,
              entry: { value: 123456789, label: null, unit: null, note: null },
              sig: SIG_A,
            }
          : slot,
      ),
    });
    expect(decodeState(legacy).slots[0].entry?.value).toBe(123456789n);
  });
});
