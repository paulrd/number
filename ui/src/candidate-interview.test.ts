import { describe, expect, it } from "vitest";
import {
  candidateRequestId,
  type CandidateMembershipV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import {
  admissionAddress,
  admissionBlockReason,
  admissionSlot,
  interviewBlockReason,
  interviewMembers,
  interviewMembersAfterAdmit,
  interviewState,
  joinCheck,
  zoneChildren,
} from "./candidate-interview";
import { emptyState, type Entry, type Slot, type StateV3 } from "./state";

const SIG = "c".repeat(128);
const OWNER = "aa".repeat(32);
const CHILD_A = "11".repeat(32);
const CHILD_B = "22".repeat(32);
const CANDIDATE = "33".repeat(32);
const OTHER = "44".repeat(32);
const ADMISSION_REFUSED =
  "Your zone already has a parent or children. Admission would move a subtree, which is not supported yet.";

function entry(contact: string): Entry {
  return { value: 0n, contact, unit: null, note: null };
}

function occupied(contact: string): Slot {
  return { seq: 1, entry: entry(contact), sig: SIG };
}

/** A v6 state with the given slots occupied and an optional parent. */
function stateWith(
  slots: Record<number, Slot>,
  parentUserId: string | null = null,
): StateV3 {
  const state = emptyState();
  for (const [index, slot] of Object.entries(slots)) {
    state.slots[Number(index)] = slot;
  }
  if (parentUserId !== null) {
    state.parent = { seq: 1, userId: parentUserId, sig: SIG };
  }
  return state;
}

function membership(
  members: string[],
  seq = 1,
  sig = SIG,
): CandidateMembershipV1 {
  return { seq, members: [...members].sort(), secrets: [], sig };
}

function candidateState(
  ...memberships: CandidateMembershipV1[]
): CandidateStateV1 {
  return {
    v: 1,
    memberships,
    messages: [],
    requests: [],
    dismissals: [],
    config: null,
  };
}

function request(
  requester: string,
  time: number,
  sig = SIG,
): CandidateRequestV1 {
  return { requester, want_cell: "", time, note: "", sig };
}

/** Eight distinct child keys, ascending: 0x10 … 0x17. */
const EIGHT_CHILDREN = Array.from({ length: 8 }, (_, index) =>
  (0x10 + index).toString(16).padStart(2, "0").repeat(32),
);

describe("zoneChildren", () => {
  it("returns occupied contacts deduped and ascending, skipping empty slots", () => {
    const state = stateWith({
      0: occupied(CHILD_B),
      2: occupied(CHILD_A),
      5: occupied(CHILD_B),
    });
    expect(zoneChildren(OWNER, state)).toEqual([CHILD_A, CHILD_B]);
  });

  it("returns an empty list for a zone with no children", () => {
    expect(zoneChildren(OWNER, emptyState())).toEqual([]);
  });

  it("does not exclude the owner from a slot contact", () => {
    const state = stateWith({ 0: occupied(OWNER), 1: occupied(CHILD_A) });
    expect(zoneChildren(OWNER, state)).toEqual([CHILD_A, OWNER]);
  });
});

describe("interviewMembers", () => {
  it("orders owner, children and candidate ascending", () => {
    const state = stateWith({ 0: occupied(CHILD_B), 1: occupied(CHILD_A) });
    expect(interviewMembers(OWNER, state, CANDIDATE)).toEqual([
      CHILD_A,
      CHILD_B,
      CANDIDATE,
      OWNER,
    ]);
  });

  it("dedupes a candidate that is already a child", () => {
    const state = stateWith({ 0: occupied(CHILD_B) });
    expect(interviewMembers(OWNER, state, CHILD_B)).toEqual([CHILD_B, OWNER]);
  });

  it("dedupes an owner named in a slot", () => {
    const state = stateWith({ 0: occupied(OWNER) });
    expect(interviewMembers(OWNER, state, CANDIDATE)).toEqual([
      CANDIDATE,
      OWNER,
    ]);
  });
});

describe("interviewMembersAfterAdmit", () => {
  it("returns owner and the other zone children, excluding the admitted candidate", () => {
    const state = stateWith({
      0: occupied(CANDIDATE),
      1: occupied(CHILD_B),
      2: occupied(CHILD_A),
    });
    expect(interviewMembersAfterAdmit(OWNER, state, CANDIDATE)).toEqual([
      CHILD_A,
      CHILD_B,
      OWNER,
    ]);
  });

  it("returns just the owner when the candidate was the only child", () => {
    const state = stateWith({ 0: occupied(CANDIDATE) });
    expect(interviewMembersAfterAdmit(OWNER, state, CANDIDATE)).toEqual([
      OWNER,
    ]);
  });

  it("dedupes a candidate that appears in two slots", () => {
    const state = stateWith({
      0: occupied(CANDIDATE),
      4: occupied(CANDIDATE),
      5: occupied(CHILD_A),
    });
    expect(interviewMembersAfterAdmit(OWNER, state, CANDIDATE)).toEqual([
      CHILD_A,
      OWNER,
    ]);
  });

  it("keeps the owner when the admitted candidate is the owner", () => {
    const state = stateWith({ 0: occupied(OWNER), 1: occupied(CHILD_A) });
    expect(interviewMembersAfterAdmit(OWNER, state, OWNER)).toEqual([
      CHILD_A,
      OWNER,
    ]);
  });

  it("returns the owner for a root zone with no children", () => {
    expect(interviewMembersAfterAdmit(OWNER, emptyState(), CANDIDATE)).toEqual([
      OWNER,
    ]);
  });
});

describe("interviewState", () => {
  const zone = stateWith({ 0: occupied(CHILD_A) });

  it("returns null without a candidate state", () => {
    expect(interviewState(null, zone, OWNER)).toBeNull();
  });

  it("returns null without a membership", () => {
    expect(interviewState(candidateState(), zone, OWNER)).toBeNull();
  });

  it("finds the single member outside owner and children", () => {
    const state = candidateState(
      membership([OWNER, CHILD_A, CANDIDATE]),
    );
    expect(interviewState(state, zone, OWNER)).toEqual({
      seq: 1,
      members: [CHILD_A, CANDIDATE, OWNER],
      candidate: CANDIDATE,
    });
  });

  it("reports no candidate when every member is the owner or a child", () => {
    const state = candidateState(membership([OWNER, CHILD_A]));
    expect(interviewState(state, zone, OWNER)).toEqual({
      seq: 1,
      members: [CHILD_A, OWNER],
      candidate: null,
    });
  });

  it("reports no candidate when more than one outsider is present", () => {
    const state = candidateState(membership([OWNER, CANDIDATE, OTHER]));
    expect(interviewState(state, zone, OWNER)).toEqual({
      seq: 1,
      members: [CANDIDATE, OTHER, OWNER],
      candidate: null,
    });
  });

  it("reads the latest membership by seq", () => {
    const state = candidateState(
      membership([OWNER, CANDIDATE], 1),
      membership([OWNER, OTHER], 2),
    );
    expect(interviewState(state, zone, OWNER)?.candidate).toBe(OTHER);
  });

  it("ignores an owner duplicated in a slot", () => {
    const ownerZone = stateWith({ 0: occupied(OWNER) });
    const state = candidateState(membership([OWNER, CANDIDATE]));
    expect(interviewState(state, ownerZone, OWNER)).toEqual({
      seq: 1,
      members: [CANDIDATE, OWNER],
      candidate: CANDIDATE,
    });
  });
});

describe("interviewBlockReason", () => {
  it("allows an invite into a free zone with no active round", () => {
    expect(
      interviewBlockReason(candidateState(), emptyState(), OWNER, CANDIDATE),
    ).toBeNull();
  });

  it("refuses an id that is not a user key", () => {
    expect(
      interviewBlockReason(null, emptyState(), OWNER, "not-a-key"),
    ).toBe("That is not a valid user id.");
  });

  it("refuses a requester that is already a child", () => {
    const zone = stateWith({ 0: occupied(CHILD_A) });
    expect(
      interviewBlockReason(candidateState(), zone, OWNER, CHILD_A),
    ).toBe("They are already in this zone.");
  });

  it("refuses while a different candidate is active", () => {
    const zone = emptyState();
    const state = candidateState(membership([OWNER, OTHER]));
    expect(
      interviewBlockReason(state, zone, OWNER, CANDIDATE),
    ).toBe("An interview is already in progress.");
  });

  it("allows the active candidate to continue", () => {
    const zone = emptyState();
    const state = candidateState(membership([OWNER, CANDIDATE]));
    expect(
      interviewBlockReason(state, zone, OWNER, CANDIDATE),
    ).toBeNull();
  });

  it("refuses when the zone already has eight children", () => {
    const slots: Record<number, Slot> = {};
    EIGHT_CHILDREN.forEach((contact, index) => {
      slots[index] = occupied(contact);
    });
    const zone = stateWith(slots);
    expect(
      interviewBlockReason(
        candidateState(),
        zone,
        OWNER,
        "99".repeat(32),
      ),
    ).toBe("This zone is full.");
  });
});

describe("admissionSlot", () => {
  it("returns the first slot whose contact is the candidate", () => {
    const zone = stateWith({
      2: occupied(CANDIDATE),
      5: occupied(CANDIDATE),
    });
    expect(admissionSlot(zone, CANDIDATE)).toBe(2);
  });

  it("returns null when the owner has not written the slot", () => {
    const zone = stateWith({ 2: occupied(CHILD_A) });
    expect(admissionSlot(zone, CANDIDATE)).toBeNull();
  });
});

describe("admissionAddress", () => {
  it("appends the slot digit to a non-root address", () => {
    expect(admissionAddress("02", 5)).toBe("025");
  });

  it("is just the digit for a root zone", () => {
    expect(admissionAddress("", 3)).toBe("3");
  });
});

describe("admissionBlockReason", () => {
  it("allows a zone with neither parent nor children", () => {
    expect(admissionBlockReason(emptyState())).toBeNull();
  });

  it("allows a cleared parent record with no children", () => {
    const state = emptyState();
    state.parent = { seq: 1, userId: null, sig: SIG };
    expect(admissionBlockReason(state)).toBeNull();
  });

  it("refuses a zone that already has a parent", () => {
    expect(admissionBlockReason(stateWith({}, CHILD_A))).toBe(
      ADMISSION_REFUSED,
    );
  });

  it("refuses a zone that already has a child", () => {
    expect(
      admissionBlockReason(stateWith({ 0: occupied(CHILD_A) })),
    ).toBe(ADMISSION_REFUSED);
  });

  it("refuses a zone that has both a parent and a child", () => {
    expect(
      admissionBlockReason(stateWith({ 3: occupied(CHILD_B) }, CHILD_A)),
    ).toBe(ADMISSION_REFUSED);
  });
});

describe("joinCheck", () => {
  it("returns none without a candidate state or target slot", () => {
    expect(joinCheck(null, emptyState(), CANDIDATE)).toEqual({ kind: "none" });
    expect(joinCheck(candidateState(), emptyState(), CANDIDATE)).toEqual({
      kind: "none",
    });
  });

  it("returns queued when the requester's request is in the queue", () => {
    const state = candidateState();
    const queued = request(CANDIDATE, 100);
    state.requests = [queued];

    expect(joinCheck(state, emptyState(), CANDIDATE)).toEqual({
      kind: "queued",
      request: queued,
    });
  });

  it("returns invited when the requester is in the latest membership", () => {
    const state = candidateState(membership([OWNER, CANDIDATE]));

    expect(joinCheck(state, emptyState(), CANDIDATE)).toEqual({
      kind: "invited",
    });
  });

  it("prefers an admission slot over an invite and a request", () => {
    const state = candidateState(membership([OWNER, CANDIDATE]));
    state.requests = [request(CANDIDATE, 100)];
    const zone = stateWith({ 5: occupied(CANDIDATE) });

    expect(joinCheck(state, zone, CANDIDATE)).toEqual({
      kind: "admitted",
      slot: 5,
    });
  });

  it("chooses the newest queued request by time", () => {
    const state = candidateState();
    const older = request(CANDIDATE, 100);
    const newer = request(CANDIDATE, 200, "d".repeat(128));
    state.requests = [newer, older];

    expect(joinCheck(state, emptyState(), CANDIDATE)).toEqual({
      kind: "queued",
      request: newer,
    });
  });

  it("breaks equal-time ties by request id", () => {
    const state = candidateState();
    const first = request(CANDIDATE, 100, "a".repeat(128));
    const second = request(CANDIDATE, 100, "b".repeat(128));
    state.requests = [first, second];
    const expected =
      candidateRequestId(first) > candidateRequestId(second) ? first : second;

    expect(joinCheck(state, emptyState(), CANDIDATE)).toEqual({
      kind: "queued",
      request: expected,
    });
  });

  it("matches the requester id exactly", () => {
    const state = candidateState();
    const requester = "ab".repeat(32);
    state.requests = [request(requester, 100)];

    expect(joinCheck(state, emptyState(), requester.toUpperCase())).toEqual({
      kind: "none",
    });
    expect(joinCheck(state, emptyState(), `${requester} `)).toEqual({
      kind: "none",
    });
    expect(joinCheck(state, emptyState(), requester)).toEqual({
      kind: "queued",
      request: state.requests[0],
    });
  });
});
