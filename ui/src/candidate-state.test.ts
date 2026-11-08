import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_MAX_DISMISSALS,
  CANDIDATE_MAX_REQUESTS,
  candidateDigest,
  candidateNoteToText,
  candidateRequestId,
  encodeCandidateDelta,
  encodeCandidateState,
  isAccepting,
  latestCandidateConfig,
  latestCandidateMembership,
  mergeCandidateStates,
  parseCandidateDelta,
  parseCandidateState,
  textToCandidateNote,
  type CandidateConfigV1,
  type CandidateDismissalV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import { bytesToHex, hexToBytes } from "./util";

interface Golden {
  owner_vk_hex: string;
  state: CandidateStateV1;
  state_bytes_hex: string;
  digest: string;
  request: { id: string };
}

const golden: Golden = JSON.parse(
  readFileSync(
    new URL("../../fixtures/candidate/golden_v1.json", import.meta.url),
    "utf-8",
  ),
);

const REQUESTER = golden.state.requests[0].requester;
const EPOCH = golden.state.memberships[0].seq;

function emptyState(): CandidateStateV1 {
  return {
    v: 1,
    memberships: [],
    messages: [],
    requests: [],
    dismissals: [],
    config: null,
  };
}

function request(index: number, overrides: Partial<CandidateRequestV1> = {}): CandidateRequestV1 {
  return {
    requester: REQUESTER,
    want_cell: "003",
    time: index,
    note: "00",
    // Unique raw signature; the request id is BLAKE3(sig)[0..16].
    sig: (index + 1).toString(16).padStart(128, "0"),
    ...overrides,
  };
}

function dismissal(id: string, sig: string): CandidateDismissalV1 {
  return { id, sig };
}

function config(
  seq: number,
  accepting: boolean,
  sig = seq.toString(16).padStart(128, "0"),
): CandidateConfigV1 {
  return { seq, accepting, sig };
}

function id(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function rawState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...emptyState(), ...overrides });
}

describe("candidate state golden vector", () => {
  it("decodes the golden state bytes", () => {
    const state = parseCandidateState(hexToBytes(golden.state_bytes_hex));
    expect(state).toEqual(golden.state);
  });

  it("re-encodes the golden state byte-identically", () => {
    const state = parseCandidateState(hexToBytes(golden.state_bytes_hex));
    expect(bytesToHex(encodeCandidateState(state))).toBe(golden.state_bytes_hex);
  });

  it("matches the golden digest, request id and accepting flag", () => {
    const state = parseCandidateState(hexToBytes(golden.state_bytes_hex));
    expect(candidateDigest(state)).toBe(golden.digest);
    expect(candidateRequestId(state.requests[0])).toBe(golden.request.id);
    expect(isAccepting(state)).toBe(true);
    expect(latestCandidateConfig(state)?.seq).toBe(1);
    expect(latestCandidateMembership(state)?.seq).toBe(EPOCH);
  });
});

describe("candidate merge", () => {
  it("is commutative, associative and idempotent", () => {
    const states: CandidateStateV1[] = [
      {
        ...emptyState(),
        requests: [request(0), request(1)],
        config: config(1, true),
      },
      {
        ...emptyState(),
        requests: [request(2)],
        dismissals: [dismissal(candidateRequestId(request(0)), "aa".repeat(64))],
        config: config(2, false),
      },
      {
        ...emptyState(),
        requests: [request(3)],
        dismissals: [dismissal(candidateRequestId(request(2)), "bb".repeat(64))],
      },
    ];

    const expected = mergeCandidateStates(
      mergeCandidateStates(states[0], states[1]),
      states[2],
    );
    expect(mergeCandidateStates(states[0], states[1])).toEqual(
      mergeCandidateStates(states[1], states[0]),
    );

    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      let result = emptyState();
      for (const index of order) result = mergeCandidateStates(result, states[index]);
      expect(result).toEqual(expected);
    }

    expect(mergeCandidateStates(expected, expected)).toEqual(expected);
  });

  it("keeps the newest 8 requests by (time, id)", () => {
    const requests = Array.from({ length: 12 }, (_, index) =>
      request(index, { time: 1_000 + index }),
    );
    const merged = mergeCandidateStates(
      { ...emptyState(), requests: requests.slice(0, 6) },
      { ...emptyState(), requests: requests.slice(6) },
    );
    expect(merged.requests).toHaveLength(CANDIDATE_MAX_REQUESTS);
    expect(merged.requests.map((item) => item.time)).toEqual([
      1_004, 1_005, 1_006, 1_007, 1_008, 1_009, 1_010, 1_011,
    ]);
  });

  it("keeps the greatest 64 dismissals in ascending id order", () => {
    const dismissals = Array.from({ length: 70 }, (_, index) =>
      dismissal(id(index + 1), (index + 1).toString(16).padStart(128, "0")),
    );
    const merged = mergeCandidateStates(
      { ...emptyState(), dismissals: dismissals.slice(0, 35) },
      { ...emptyState(), dismissals: dismissals.slice(35) },
    );
    expect(merged.dismissals).toHaveLength(CANDIDATE_MAX_DISMISSALS);
    expect(merged.dismissals[0].id).toBe(id(7));
    expect(merged.dismissals.at(-1)?.id).toBe(id(70));
    const sorted = [...merged.dismissals].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    expect(merged.dismissals).toEqual(sorted);
  });

  it("drops a replayed request whose id is dismissed", () => {
    const ask = request(0);
    const merged = mergeCandidateStates(
      { ...emptyState(), requests: [ask] },
      { ...emptyState(), dismissals: [dismissal(candidateRequestId(ask), "cc".repeat(64))] },
    );
    expect(merged.requests).toEqual([]);
    expect(merged.dismissals).toHaveLength(1);
  });

  it("merges config by greatest seq then greatest signature", () => {
    const lower = mergeCandidateStates(
      { ...emptyState(), config: config(1, true) },
      { ...emptyState(), config: config(2, false) },
    );
    expect(lower.config).toEqual(config(2, false));

    const tie = mergeCandidateStates(
      { ...emptyState(), config: config(4, true, "aa".repeat(64)) },
      { ...emptyState(), config: config(4, false, "bb".repeat(64)) },
    );
    expect(tie.config).toEqual(config(4, false, "bb".repeat(64)));
    expect(mergeCandidateStates(emptyState(), emptyState()).config).toBeNull();
  });
});

describe("candidate delta", () => {
  it("round-trips a full state", () => {
    const state = parseCandidateState(hexToBytes(golden.state_bytes_hex));
    const bytes = encodeCandidateDelta({ v: 1, full: state });
    expect(parseCandidateDelta(bytes)).toEqual({ v: 1, full: state });
  });

  it("round-trips incremental records and omits empty arrays", () => {
    const ask = request(0);
    const delta = {
      v: 1 as const,
      requests: [ask],
      dismissals: [dismissal(candidateRequestId(ask), "dd".repeat(64))],
      config: config(2, false),
    };
    const bytes = encodeCandidateDelta(delta);
    expect(parseCandidateDelta(bytes)).toEqual(delta);
    expect(new TextDecoder().decode(encodeCandidateDelta({ v: 1 }))).toBe(
      '{"v":1}',
    );
    expect(
      new TextDecoder().decode(
        encodeCandidateDelta({ v: 1, requests: [] }),
      ),
    ).toBe('{"v":1}');
  });

  it("rejects a full delta that also carries incremental fields", () => {
    const state = parseCandidateState(hexToBytes(golden.state_bytes_hex));
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        full: state,
        requests: [state.requests[0]],
      }),
    );
    expect(() => parseCandidateDelta(bytes)).toThrow(/mutually exclusive/);
    const configBytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, full: state, config: state.config }),
    );
    expect(() => parseCandidateDelta(configBytes)).toThrow(/mutually exclusive/);
  });
});

describe("candidate parsing", () => {
  it("encodes config as null and rejects a missing config field", () => {
    const bytes = encodeCandidateState(emptyState());
    expect(new TextDecoder().decode(bytes)).toContain('"config":null');
    expect(parseCandidateState(bytes).config).toBeNull();

    const missing = JSON.stringify({
      v: 1,
      memberships: [],
      messages: [],
      requests: [],
      dismissals: [],
    });
    expect(() =>
      parseCandidateState(new TextEncoder().encode(missing)),
    ).toThrow(/config/);
  });

  it("rejects a bad want_cell", () => {
    for (const want_cell of ["8", "00a", "0".repeat(33)]) {
      const bytes = new TextEncoder().encode(
        rawState({ requests: [{ ...request(0), want_cell }] }),
      );
      expect(() => parseCandidateState(bytes)).toThrow(/want_cell/);
    }
  });

  it("rejects a bad note", () => {
    for (const note of ["abc", "zz", "00".repeat(257)]) {
      const bytes = new TextEncoder().encode(
        rawState({ requests: [{ ...request(0), note }] }),
      );
      expect(() => parseCandidateState(bytes)).toThrow(/note/);
    }
  });

  it("rejects a bad dismissal id and bad config", () => {
    const badId = new TextEncoder().encode(
      rawState({ dismissals: [{ id: "ab".repeat(15), sig: "aa".repeat(64) }] }),
    );
    expect(() => parseCandidateState(badId)).toThrow(/id/);

    const badSeq = new TextEncoder().encode(
      rawState({ config: { seq: 0, accepting: true, sig: "aa".repeat(64) } }),
    );
    expect(() => parseCandidateState(badSeq)).toThrow(/seq/);

    const badAccepting = new TextEncoder().encode(
      rawState({ config: { seq: 1, accepting: "yes", sig: "aa".repeat(64) } }),
    );
    expect(() => parseCandidateState(badAccepting)).toThrow(/accepting/);
  });

  it("rejects unknown top-level shapes", () => {
    for (const payload of ["{}", "[]", "null", JSON.stringify({ v: 2 })]) {
      expect(() =>
        parseCandidateState(new TextEncoder().encode(payload)),
      ).toThrow();
    }
  });

  it("treats an absent config as accepting", () => {
    expect(isAccepting(emptyState())).toBe(true);
    expect(isAccepting({ ...emptyState(), config: config(1, false) })).toBe(
      false,
    );
  });

  it("round-trips UTF-8 notes and allows an empty note", () => {
    for (const text of ["", "hello candidate", "héllo → 世界", "🙂"]) {
      const note = textToCandidateNote(text);
      expect(note).toMatch(/^[0-9a-f]*$/);
      expect(candidateNoteToText(note)).toBe(text);
    }
    expect(candidateNoteToText("ff")).toBe("\uFFFD");
  });
});
