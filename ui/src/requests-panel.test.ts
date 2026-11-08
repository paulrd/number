import { describe, expect, it } from "vitest";
import {
  candidateRequestId,
  textToCandidateNote,
  type CandidateMembershipV1,
  type CandidateMessageV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import { emptyState, type StateV3 } from "./state";
import {
  REQUEST_NOTE_DISPLAY_LIMIT,
  clearSummary,
  dismissSequentially,
  formatRequestCell,
  formatRequestTime,
  interviewBodyView,
  interviewCandidateView,
  interviewComposerLimit,
  interviewMembershipLock,
  interviewMessageRows,
  interviewOutsideMembers,
  interviewRemainingMembers,
  joinLink,
  notePreview,
  requestCountLabel,
  requestNoteText,
  requestRows,
  requestTimeIso,
  requestsErrorText,
  shortRequester,
} from "./requests-panel";

const REQUESTER = "bb".repeat(32);

function request(overrides: Partial<CandidateRequestV1> = {}): CandidateRequestV1 {
  return {
    requester: REQUESTER,
    want_cell: "003",
    time: 1_700_000_000_000,
    note: textToCandidateNote("hello"),
    sig: "1".repeat(128),
    ...overrides,
  };
}

function state(requests: CandidateRequestV1[] = []): CandidateStateV1 {
  return {
    v: 1,
    memberships: [],
    messages: [],
    requests,
    dismissals: [],
    config: null,
  };
}

describe("formatRequestCell", () => {
  it("spells the empty cell as the world", () => {
    expect(formatRequestCell("")).toBe("world");
  });

  it("labels digits as a cell", () => {
    expect(formatRequestCell("003")).toBe("cell 003");
  });
});

describe("shortRequester", () => {
  it("keeps both ends of a long key", () => {
    expect(shortRequester(REQUESTER)).toBe(
      `${REQUESTER.slice(0, 8)}…${REQUESTER.slice(-8)}`,
    );
  });

  it("leaves a short value alone", () => {
    expect(shortRequester("abcd")).toBe("abcd");
  });
});

describe("requestNoteText", () => {
  it("decodes the contract's hex note", () => {
    expect(requestNoteText(textToCandidateNote("hello"))).toBe("hello");
    expect(requestNoteText("")).toBe("");
  });

  it("reports malformed hex without throwing", () => {
    expect(requestNoteText("zz")).toBe("Unreadable note");
  });
});

describe("notePreview", () => {
  it("leaves a short note unchanged", () => {
    expect(notePreview("a short note")).toEqual({
      text: "a short note",
      truncated: false,
    });
  });

  it("caps a long note with an ellipsis", () => {
    const long = "x".repeat(REQUEST_NOTE_DISPLAY_LIMIT + 20);
    const preview = notePreview(long);
    expect(preview.truncated).toBe(true);
    expect(preview.text).toBe(
      `${"x".repeat(REQUEST_NOTE_DISPLAY_LIMIT)}…`,
    );
  });

  it("does not split a surrogate pair", () => {
    const preview = notePreview("😀".repeat(REQUEST_NOTE_DISPLAY_LIMIT + 5));
    expect(preview.truncated).toBe(true);
    expect(Array.from(preview.text)).toHaveLength(
      REQUEST_NOTE_DISPLAY_LIMIT + 1,
    );
    expect(preview.text).not.toContain("\uFFFD");
  });
});

describe("request time", () => {
  it("renders a full ISO title", () => {
    expect(requestTimeIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(requestTimeIso(Number.NaN)).toBeNull();
  });

  it("falls back to a readable label for an impossible time", () => {
    expect(formatRequestTime(Number.NaN)).toBe("Unknown time");
  });

  it("shows a local string for a real time", () => {
    const text = formatRequestTime(1_700_000_000_000);
    expect(text).not.toBe("Unknown time");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("requestCountLabel", () => {
  it("uses singular and plural forms", () => {
    expect(requestCountLabel(0)).toBe("No open requests");
    expect(requestCountLabel(1)).toBe("1 open request");
    expect(requestCountLabel(3)).toBe("3 open requests");
  });
});

describe("requestRows", () => {
  it("is empty for a missing room", () => {
    expect(requestRows(null)).toEqual([]);
  });

  it("reverses the retained order so newest comes first", () => {
    const older = request({ time: 1_000 });
    const newer = request({ time: 2_000, sig: "2".repeat(128) });
    expect(requestRows(state([older, newer]))).toEqual([newer, older]);
  });
});

describe("joinLink", () => {
  const owner = "ab".repeat(32);

  it("builds origin, path and the root parameter", () => {
    expect(joinLink("https://example.test", "/app/", owner)).toBe(
      `https://example.test/app/?root=${owner}`,
    );
    expect(joinLink("https://example.test", "/app", owner)).toBe(
      `https://example.test/app?root=${owner}`,
    );
  });

  it("drops other query parameters and the fragment", () => {
    expect(
      joinLink(
        "https://example.test",
        "/app/index.html?view=advanced&root=" + "cd".repeat(32) + "#top",
        owner,
      ),
    ).toBe(`https://example.test/app/index.html?root=${owner}`);
  });
});

describe("clearSummary", () => {
  it("reports the count and any rows left", () => {
    expect(clearSummary(2, 1)).toBe("Cleared 2 requests. 1 request remains.");
    expect(clearSummary(1, 3)).toBe("Cleared 1 request. 3 requests remain.");
    expect(clearSummary(3, 0)).toBe("Cleared 3 requests.");
  });

  it("says plainly when nothing was cleared", () => {
    expect(clearSummary(0, 1)).toBe(
      "No requests cleared. 1 request remains.",
    );
    expect(clearSummary(0, 0)).toBe("No requests cleared. Nothing remains.");
  });
});

describe("dismissSequentially", () => {
  it("dismisses one at a time and continues after a failure", async () => {
    const first = request({ time: 1_000 });
    const second = request({ time: 2_000, sig: "2".repeat(128) });
    const third = request({ time: 3_000, sig: "3".repeat(128) });
    const ids = [first, second, third].map(candidateRequestId);
    const calls: string[] = [];

    const result = await dismissSequentially(ids, async (id) => {
      calls.push(id);
      if (id === ids[1]) throw new Error("nope");
      return state([third]);
    });

    expect(calls).toEqual(ids);
    expect(result.cleared).toEqual([ids[0], ids[2]]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe(ids[1]);
    expect(result.state).toEqual(state([third]));
  });

  it("stops when the panel is closed", async () => {
    const ids = ["a".repeat(32), "b".repeat(32)];
    let stop = false;
    const calls: string[] = [];
    const result = await dismissSequentially(
      ids,
      async (id) => {
        calls.push(id);
        stop = true;
        return state([]);
      },
      () => stop,
    );
    expect(calls).toEqual([ids[0]]);
    expect(result.cleared).toEqual([ids[0]]);
  });
});

describe("requestsErrorText", () => {
  it("names offline for a read failure", () => {
    expect(requestsErrorText({ code: "connection" }, "read")).toContain(
      "offline",
    );
  });

  it("keeps action failures readable", () => {
    expect(requestsErrorText({ code: "sign" }, "accepting")).toContain(
      "identity is ready",
    );
    expect(requestsErrorText({ code: "not-owner" }, "dismiss")).toContain(
      "Only this zone's owner",
    );
    expect(requestsErrorText(new Error("boom"), "dismiss")).toContain("boom");
  });

  it("mentions the owner id only in the read path", () => {
    expect(requestsErrorText({ code: "read" }, "read")).toBe(
      "The request queue could not be read. Try again.",
    );
  });
});

const OWNER = "aa".repeat(32);
const CHILD = "cc".repeat(32);
const CANDIDATE = "dd".repeat(32);

function membership(
  seq: number,
  members: string[],
  secrets: CandidateMembershipV1["secrets"] = [],
): CandidateMembershipV1 {
  return { seq, members, secrets, sig: "1".repeat(128) };
}

function roomState(
  memberships: CandidateMembershipV1[],
  messages: CandidateMessageV1[] = [],
): CandidateStateV1 {
  return {
    v: 1,
    memberships,
    messages,
    requests: [],
    dismissals: [],
    config: null,
  };
}

function message(
  epoch: number,
  author: string,
  body: string,
  time: number,
  sig: string,
): CandidateMessageV1 {
  return { author, epoch, seq: 1, time, body, sig };
}

function zoneWithChild(contact = CHILD): StateV3 {
  const state = emptyState();
  state.slots[0] = {
    seq: 1,
    entry: { value: 0n, contact, unit: null, note: null },
    sig: "2".repeat(128),
  };
  return state;
}

describe("interviewComposerLimit", () => {
  it("uses the legacy cap without secrets and the encrypted cap with them", () => {
    expect(interviewComposerLimit(null)).toBe(1024);
    expect(interviewComposerLimit(membership(1, [OWNER]))).toBe(1024);
    expect(
      interviewComposerLimit(
        membership(1, [OWNER], [{ recipient: OWNER, blob: "00" }]),
      ),
    ).toBe(995);
  });
});

describe("interviewMessageRows", () => {
  it("is empty without a signed membership", () => {
    expect(
      interviewMessageRows([message(1, OWNER, "6869", 1, "a".repeat(128))], null),
    ).toEqual([]);
  });

  it("keeps only the latest epoch, newest last", () => {
    const state = roomState([membership(2, [OWNER, CANDIDATE])], [
      message(1, OWNER, "6f6c64", 1, "a".repeat(128)),
      message(2, OWNER, "6e6577", 3, "c".repeat(128)),
      message(2, CANDIDATE, "6869", 2, "b".repeat(128)),
    ]);
    const latest = state.memberships[0]!;
    expect(interviewMessageRows(state.messages, latest).map((row) => row.message.body)).toEqual([
      "6869",
      "6e6577",
    ]);
  });
});

describe("interviewOutsideMembers", () => {
  it("excludes the owner and occupied slot contacts", () => {
    expect(
      interviewOutsideMembers(zoneWithChild(), OWNER, [
        OWNER,
        CHILD,
        CANDIDATE,
      ]),
    ).toEqual([CANDIDATE]);
  });
});

describe("interviewCandidateView", () => {
  it("finds the single outsider", () => {
    const state = roomState([membership(1, [OWNER, CHILD, CANDIDATE])]);
    expect(interviewCandidateView(state, zoneWithChild(), OWNER)).toEqual({
      candidate: CANDIDATE,
      warning: null,
    });
  });

  it("has no candidate after the interview ends", () => {
    const state = roomState([membership(2, [OWNER, CHILD])]);
    expect(interviewCandidateView(state, zoneWithChild(), OWNER)).toEqual({
      candidate: null,
      warning: null,
    });
  });

  it("warns instead of guessing when several outsiders are signed", () => {
    const state = roomState([membership(1, [OWNER, CANDIDATE, "ee".repeat(32)])]);
    const view = interviewCandidateView(state, emptyState(), OWNER);
    expect(view.candidate).toBeNull();
    expect(view.warning).toContain("more than one candidate");
  });

  it("keeps a deduped self invite visible", () => {
    const state = roomState([membership(1, [OWNER])]);
    expect(interviewCandidateView(state, emptyState(), OWNER, OWNER)).toEqual({
      candidate: OWNER,
      warning: null,
    });
    expect(interviewCandidateView(state, emptyState(), OWNER)).toEqual({
      candidate: null,
      warning: null,
    });
  });
});

describe("interviewMembershipLock", () => {
  it("opens when the zone set and signed membership agree", () => {
    expect(
      interviewMembershipLock(
        OWNER,
        zoneWithChild(),
        CANDIDATE,
        membership(1, [OWNER, CHILD, CANDIDATE]),
      ),
    ).toBeNull();
  });

  it("locks when the signed membership is stale", () => {
    expect(
      interviewMembershipLock(
        OWNER,
        zoneWithChild(),
        CANDIDATE,
        membership(1, [OWNER, CANDIDATE]),
      ),
    ).toContain("disagree");
  });

  it("locks when the zone could not be read", () => {
    expect(
      interviewMembershipLock(OWNER, null, CANDIDATE, membership(1, [OWNER])),
    ).toContain("zone could not be read");
  });
});

describe("interviewRemainingMembers", () => {
  it("keeps the owner and zone children only", () => {
    const zone = zoneWithChild();
    zone.slots[1] = zone.slots[0]!;
    expect(interviewRemainingMembers(OWNER, zone)).toEqual([OWNER, CHILD]);
  });
});

describe("interviewBodyView", () => {
  it("decodes a legacy body as plaintext", () => {
    expect(interviewBodyView("6869", undefined)).toEqual({
      kind: "plaintext",
      text: "hi",
    });
  });

  it("never decodes an encrypted envelope as plaintext while pending", () => {
    expect(interviewBodyView(`01${"00".repeat(40)}`, undefined)).toBeNull();
  });

  it("uses the cached decrypted view for an envelope", () => {
    expect(
      interviewBodyView(`01${"00".repeat(40)}`, {
        kind: "encrypted",
        text: "hello",
      }),
    ).toEqual({ kind: "encrypted", text: "hello" });
  });

  it("reports malformed plaintext hex as unreadable", () => {
    expect(interviewBodyView("zz", undefined)).toEqual({ kind: "unreadable" });
  });
});

describe("interview errors", () => {
  it("names each interview write", () => {
    expect(requestsErrorText({ code: "connection" }, "interview")).toContain(
      "interview was not started",
    );
    expect(requestsErrorText({ code: "crypto" }, "message")).toContain(
      "message was not sent",
    );
    expect(requestsErrorText({ code: "sign" }, "end")).toContain(
      "interview was not ended",
    );
    expect(requestsErrorText({ code: "connection" }, "zone")).toContain(
      "offline",
    );
  });
});
