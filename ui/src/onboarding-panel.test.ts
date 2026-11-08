import { afterEach, describe, expect, it, vi } from "vitest";
import {
  candidateRequestId,
  textToCandidateNote,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import {
  admittedAddressText,
  admittedDigitLabel,
  admittedSlotLabel,
  candidateStatusLine,
  chainAddress,
  createStatusWatch,
  expectedAdmissionOwner,
  formatWantCell,
  interviewAuthorLabel,
  interviewErrorText,
  joinStatusMessage,
  noteByteLabel,
  parseTargetHint,
  requestErrorText,
  requestIdFor,
  requestNoteDisplay,
  rootErrorText,
  signJoinErrorText,
  statusErrorText,
  stripJoinParams,
} from "./onboarding-panel";

function request(overrides: Partial<CandidateRequestV1> = {}): CandidateRequestV1 {
  return {
    requester: "a".repeat(64),
    want_cell: "01",
    time: 1_000,
    note: textToCandidateNote("hello"),
    sig: "b".repeat(128),
    ...overrides,
  };
}

function state(overrides: Partial<CandidateStateV1> = {}): CandidateStateV1 {
  return {
    v: 1,
    memberships: [],
    messages: [],
    requests: [],
    dismissals: [],
    config: null,
    ...overrides,
  };
}

describe("noteByteLabel", () => {
  it("counts UTF-8 bytes and names the limit", () => {
    expect(noteByteLabel("")).toBe("0 / 256 bytes");
    expect(noteByteLabel("é")).toBe("2 / 256 bytes");
    expect(noteByteLabel("abc")).toBe("3 / 256 bytes");
  });

  it("warns when the note is over the limit", () => {
    expect(noteByteLabel("a".repeat(257))).toBe("257 / 256 bytes — too long");
  });
});

describe("formatWantCell", () => {
  it("spells the empty cell as the world", () => {
    expect(formatWantCell("")).toBe("world");
    expect(formatWantCell("012")).toBe("cell 012");
  });
});

describe("chainAddress", () => {
  it("spells the root with no address", () => {
    expect(chainAddress("")).toBe("root");
    expect(chainAddress("03")).toBe("03");
  });
});

describe("rootErrorText", () => {
  it("turns the validation reasons into readable sentences", () => {
    expect(rootErrorText("the root id must be 64 lowercase hex characters")).toContain(
      "64 lowercase hex",
    );
    expect(rootErrorText("zone abc is unreadable")).toContain("could not be read");
    expect(rootErrorText("zone abc is a child of def (mutual parent)")).toContain(
      "child zone",
    );
    expect(rootErrorText("something else")).toBe(
      "That root could not be used: something else.",
    );
  });
});

describe("candidateStatusLine", () => {
  it("shows accepting with an empty queue for a missing state", () => {
    expect(candidateStatusLine(null)).toBe(
      "Accepting requests · 0 of 8 waiting",
    );
  });

  it("shows a closed zone and the queue count", () => {
    const closed = state({
      requests: [request(), request(), request()],
      config: { seq: 1, accepting: false, sig: "c".repeat(128) },
    });
    expect(candidateStatusLine(closed)).toBe(
      "Not accepting requests · 3 of 8 waiting",
    );
  });
});

describe("requestErrorText", () => {
  it("maps candidate error codes to plain sentences", () => {
    expect(requestErrorText({ code: "connection" })).toContain("Could not reach");
    expect(requestErrorText({ code: "write" })).toContain("did not accept");
    expect(requestErrorText({ code: "sign" })).toContain("could not be signed");
    expect(requestErrorText(new Error("boom"))).toBe(
      "The request could not be sent: boom",
    );
  });
});

describe("requestIdFor", () => {
  it("returns the derived id of the matching request", () => {
    const record = request({ time: 2_000 });
    const id = requestIdFor(
      state({ requests: [record] }),
      record.requester,
      record.want_cell,
      "hello",
    );
    expect(id).toBe(candidateRequestId(record));
  });

  it("takes the newest matching request", () => {
    const older = request({ time: 1_000 });
    const newer = request({ time: 2_000 });
    const id = requestIdFor(
      state({ requests: [older, newer] }),
      newer.requester,
      newer.want_cell,
      "hello",
    );
    expect(id).toBe(candidateRequestId(newer));
  });

  it("falls back to the requester's newest entry", () => {
    const record = request({ time: 3_000, note: textToCandidateNote("other") });
    const id = requestIdFor(
      state({ requests: [record] }),
      record.requester,
      record.want_cell,
      "hello",
    );
    expect(id).toBe(candidateRequestId(record));
  });

  it("returns null when the requester has no entry", () => {
    expect(requestIdFor(state(), "d".repeat(64), "01", "hello")).toBeNull();
  });
});

describe("joinStatusMessage", () => {
  it("names the three pending states", () => {
    expect(joinStatusMessage("queued")).toBe(
      "Request sent. Waiting for the owner.",
    );
    expect(joinStatusMessage("invited")).toBe("You're invited to interview.");
    expect(joinStatusMessage("admitted")).toBe("You've been admitted");
  });
});

describe("admitted labels and address", () => {
  it("uses a one-based slot and a zero-based digit", () => {
    expect(admittedSlotLabel(0)).toBe("Slot 1");
    expect(admittedSlotLabel(7)).toBe("Slot 8");
    expect(admittedDigitLabel(2)).toBe("zero-based digit 2, cell c");
  });

  it("appends the root or nested target address", () => {
    expect(admittedAddressText("", 0)).toBe("0");
    expect(admittedAddressText("02", 5)).toBe("025");
  });

  it("keeps the address unknown rather than inventing one", () => {
    expect(admittedAddressText(null, 3)).toBeNull();
  });
});

describe("requestNoteDisplay", () => {
  it("decodes the note and spells the empty case", () => {
    expect(requestNoteDisplay(textToCandidateNote("hello"))).toBe("hello");
    expect(requestNoteDisplay(textToCandidateNote("  "))).toBe("(no note)");
  });

  it("never throws on malformed hex", () => {
    expect(requestNoteDisplay("zz")).toBe("Unreadable note");
  });
});

describe("interviewAuthorLabel", () => {
  const self = "a".repeat(64);
  const target = "b".repeat(64);

  it("names the two sides of the interview", () => {
    expect(interviewAuthorLabel(self, self, target)).toBe("You");
    expect(interviewAuthorLabel(target, self, target)).toBe("Owner");
    expect(interviewAuthorLabel("c".repeat(64), self, target)).toBe(
      "Member cccccccc",
    );
  });
});

describe("pending errors", () => {
  it("maps interview write failures", () => {
    expect(interviewErrorText({ code: "connection" })).toContain(
      "Check your connection",
    );
    expect(interviewErrorText({ code: "not-member" })).toContain(
      "no longer in the interview",
    );
    expect(interviewErrorText(new Error("boom"))).toContain("boom");
  });

  it("maps status reads and the consent signature", () => {
    expect(statusErrorText({ code: "connection" })).toContain("offline");
    expect(statusErrorText(new Error("boom"))).toContain("boom");
    expect(signJoinErrorText({ code: "connection" })).toContain("offline");
    expect(signJoinErrorText({ code: "sign" })).toContain(
      "identity is ready",
    );
  });
});

describe("parseTargetHint", () => {
  const target = "e".repeat(64);

  it("reads exactly one valid target parameter", () => {
    expect(parseTargetHint(`?root=${"a".repeat(64)}&target=${target}`)).toBe(
      target,
    );
    expect(parseTargetHint(`target=${target}`)).toBe(target);
  });

  it("ignores a missing, duplicate or malformed target", () => {
    expect(parseTargetHint(`?root=${"a".repeat(64)}`)).toBeNull();
    expect(parseTargetHint(`?target=${target}&target=${target}`)).toBeNull();
    expect(parseTargetHint(`?target=${"E".repeat(64)}`)).toBeNull();
    expect(parseTargetHint("?target=abc")).toBeNull();
  });
});

describe("expectedAdmissionOwner", () => {
  const root = "a".repeat(64);
  const target = "b".repeat(64);

  it("prefers the requested target over the shared root", () => {
    // The match walk can descend: the admitting zone need not be `?root=`.
    expect(expectedAdmissionOwner(`?root=${root}&target=${target}`, root)).toBe(
      target,
    );
  });

  it("falls back to an open flow's root", () => {
    expect(expectedAdmissionOwner("", root)).toBe(root);
    expect(expectedAdmissionOwner(`?root=${root}`, root)).toBe(root);
  });

  it("is null when the flow names no owner", () => {
    expect(expectedAdmissionOwner("", null)).toBeNull();
    expect(expectedAdmissionOwner("?target=bad", null)).toBeNull();
  });
});

describe("stripJoinParams", () => {
  it("removes root and target without disturbing other parameters", () => {
    const url = new URL(
      `https://example.test/app?view=advanced&root=${"a".repeat(64)}` +
        `&target=${"b".repeat(64)}#top`,
    );
    stripJoinParams(url);
    expect(url.searchParams.has("root")).toBe(false);
    expect(url.searchParams.has("target")).toBe(false);
    expect(url.searchParams.get("view")).toBe("advanced");
    expect(url.hash).toBe("#top");
  });

  it("also removes an admission code parameter", () => {
    const url = new URL(
      `https://example.test/app?view=advanced&admit=tally-admit1.abc#top`,
    );
    stripJoinParams(url);
    expect(url.searchParams.has("admit")).toBe(false);
    expect(url.searchParams.get("view")).toBe("advanced");
    expect(url.hash).toBe("#top");
  });

  it("is safe when the hints are absent", () => {
    const url = new URL("https://example.test/app?view=simple");
    stripJoinParams(url);
    expect(url.toString()).toBe("https://example.test/app?view=simple");
  });
});

describe("createStatusWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const cleanups: Array<{ id: string; stop: ReturnType<typeof vi.fn> }> = [];
    const callbacks = new Map<string, () => void>();
    const recheck = vi.fn();
    let busy = false;
    const watch = createStatusWatch({
      watchBoard: (id, onChange) => {
        const stop = vi.fn();
        cleanups.push({ id, stop });
        callbacks.set(id, onChange);
        return stop;
      },
      recheck,
      isBusy: () => busy,
      debounceMs: 500,
    });
    return {
      watch,
      recheck,
      callbacks,
      cleanups,
      setBusy: (value: boolean) => {
        busy = value;
      },
    };
  }

  it("starts one watch per target and cleans up when it changes", () => {
    const { watch, cleanups } = setup();
    watch.setTarget("a");
    watch.setTarget("a");
    expect(cleanups.map((entry) => entry.id)).toEqual(["a"]);
    expect(watch.target()).toBe("a");

    watch.setTarget("b");
    expect(cleanups[0]!.stop).toHaveBeenCalledTimes(1);
    expect(cleanups.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(watch.target()).toBe("b");
  });

  it("debounces multiple notifications into one re-check", () => {
    vi.useFakeTimers();
    const { watch, recheck, callbacks } = setup();
    watch.setTarget("a");
    callbacks.get("a")!();
    callbacks.get("a")!();
    vi.advanceTimersByTime(499);
    expect(recheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith("a");
  });

  it("waits for an in-flight check and re-checks after it settles", () => {
    vi.useFakeTimers();
    const { watch, recheck, callbacks, setBusy } = setup();
    watch.setTarget("a");
    setBusy(true);
    callbacks.get("a")!();
    vi.advanceTimersByTime(1000);
    expect(recheck).not.toHaveBeenCalled();

    setBusy(false);
    watch.settled();
    vi.advanceTimersByTime(500);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith("a");
  });

  it("stops on null and ignores late notifications", () => {
    vi.useFakeTimers();
    const { watch, recheck, callbacks, cleanups } = setup();
    watch.setTarget("a");
    const notify = callbacks.get("a")!;
    watch.setTarget(null);
    expect(cleanups[0]!.stop).toHaveBeenCalledTimes(1);
    expect(watch.target()).toBeNull();

    notify();
    vi.advanceTimersByTime(1000);
    expect(recheck).not.toHaveBeenCalled();

    watch.stop();
    expect(cleanups[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending re-check when stopped", () => {
    vi.useFakeTimers();
    const { watch, recheck, callbacks } = setup();
    watch.setTarget("a");
    callbacks.get("a")!();
    watch.stop();
    vi.advanceTimersByTime(1000);
    expect(recheck).not.toHaveBeenCalled();
  });
});
