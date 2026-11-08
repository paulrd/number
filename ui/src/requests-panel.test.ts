import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateTransport } from "./candidate-client";
import {
  candidateRequestId,
  textToCandidateNote,
  type CandidateMembershipV1,
  type CandidateMessageV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import { decodeAdmissionCode } from "./admission";
import { emptyState, type StateV3 } from "./state";
import {
  REQUEST_NOTE_DISPLAY_LIMIT,
  ADMISSION_NO_FREE_SLOT,
  admissionAnnouncement,
  admissionCodeCopyAnnouncement,
  admissionCodeCopyStatus,
  admissionFinishMembers,
  admissionView,
  clearSummary,
  createRequestsPanel,
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
  notePreview,
  requestCountLabel,
  requestNoteText,
  requestRows,
  requestTimeIso,
  requestsErrorText,
  rootIdCopyAnnouncement,
  rootIdCopyStatus,
  shareRootId,
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

describe("shareRootId", () => {
  const owner = "ab".repeat(32);

  it("is exactly the bare owner id", () => {
    expect(shareRootId(owner)).toBe(owner);
    expect(shareRootId(owner)).toMatch(/^[0-9a-f]{64}$/);
    expect(shareRootId(owner)).not.toContain("://");
    expect(shareRootId(owner)).not.toContain("?");
    expect(shareRootId(owner)).not.toContain("=");
  });

  it("normalises surrounding space and case", () => {
    expect(shareRootId(`  ${owner.toUpperCase()}  `)).toBe(owner);
  });
});

describe("root id copy feedback", () => {
  it("labels the copying, copied and manual states", () => {
    expect(rootIdCopyStatus("idle")).toBe("");
    expect(rootIdCopyStatus("copying")).toBe("Copying the root id…");
    expect(rootIdCopyStatus("copied")).toBe("Copied.");
    expect(rootIdCopyStatus("manual")).toContain(
      "Select the root id and copy it manually.",
    );
  });

  it("announces a successful copy and the manual fallback", () => {
    expect(rootIdCopyAnnouncement("copied")).toBe("Root id copied.");
    expect(rootIdCopyAnnouncement("manual")).toContain(
      "The root id is shown for manual copying.",
    );
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

  it("names the admission writes", () => {
    expect(requestsErrorText({ code: "connection" }, "admit")).toContain(
      "slot editor could not be opened",
    );
    expect(requestsErrorText({ code: "connection" }, "finish")).toContain(
      "Admission was not finished",
    );
    expect(requestsErrorText(new Error("full"), "finish")).toContain("full");
  });

  it("explains a full zone without a free slot", () => {
    expect(ADMISSION_NO_FREE_SLOT).toContain("no free slot");
    expect(ADMISSION_NO_FREE_SLOT).toContain("Clear a slot");
  });
});

const ASSIGNED = "ee".repeat(32);

function zoneWithCandidate(contact = CANDIDATE): StateV3 {
  const zone = zoneWithChild(CHILD);
  zone.slots[1] = {
    seq: 1,
    entry: { value: 0n, contact, unit: null, note: null },
    sig: "3".repeat(128),
  };
  return zone;
}

describe("admissionView", () => {
  it("is null until a slot names the candidate", () => {
    expect(admissionView(zoneWithChild(), CANDIDATE, "")).toBeNull();
    expect(admissionView(zoneWithCandidate(), null, "")).toBeNull();
    expect(admissionView(null, CANDIDATE, "")).toBeNull();
  });

  it("labels the slot one-based and the digit zero-based", () => {
    expect(admissionView(zoneWithCandidate(), CANDIDATE, "")).toEqual({
      slot: 1,
      label: "Slot 2 written",
      digit: "1",
      address: "1",
      region: "Region 1",
    });
  });

  it("appends the root or nested owner address", () => {
    expect(admissionView(zoneWithCandidate(), CANDIDATE, "02")).toMatchObject({
      address: "021",
      region: "Region 021",
    });
    expect(admissionView(zoneWithCandidate(), CANDIDATE, "")).toMatchObject({
      address: "1",
      region: "Region 1",
    });
  });

  it("keeps the label when the owner address is unknown", () => {
    expect(admissionView(zoneWithCandidate(), CANDIDATE, null)).toEqual({
      slot: 1,
      label: "Slot 2 written",
      digit: "1",
      address: null,
      region: null,
    });
  });

  it("does not confuse another admission with the candidate", () => {
    expect(admissionView(zoneWithCandidate(ASSIGNED), CANDIDATE, "")).toBeNull();
  });
});

describe("admission transitions", () => {
  it("keeps the invited candidate visible once the slot makes them a child", () => {
    const room = roomState([membership(2, [OWNER, CHILD, CANDIDATE])]);
    const before = interviewCandidateView(
      room,
      zoneWithChild(),
      OWNER,
      CANDIDATE,
    );
    expect(before.candidate).toBe(CANDIDATE);
    expect(admissionView(zoneWithChild(), before.candidate, "0")).toBeNull();

    const after = interviewCandidateView(
      room,
      zoneWithCandidate(),
      OWNER,
      CANDIDATE,
    );
    expect(after).toEqual({ candidate: CANDIDATE, warning: null });
    expect(admissionView(zoneWithCandidate(), after.candidate, "0")).toMatchObject({
      slot: 1,
      address: "01",
    });
  });

  it("clears the designation when the slot is cleared", () => {
    expect(admissionView(zoneWithCandidate(), CANDIDATE, "0")).not.toBeNull();
    expect(admissionView(zoneWithChild(), CANDIDATE, "0")).toBeNull();
  });

  it("announces the slot and the address together", () => {
    expect(
      admissionAnnouncement(admissionView(zoneWithCandidate(), CANDIDATE, "02")!),
    ).toBe("Slot 2 written. Region 021.");
    expect(
      admissionAnnouncement(admissionView(zoneWithCandidate(), CANDIDATE, null)!),
    ).toBe("Slot 2 written.");
  });
});

describe("admissionFinishMembers", () => {
  it("drops the admitted candidate and keeps the other children", () => {
    expect(
      admissionFinishMembers(OWNER, zoneWithCandidate(), CANDIDATE),
    ).toEqual([OWNER, CHILD]);
  });

  it("keeps the owner even in the defensive self-admit case", () => {
    expect(admissionFinishMembers(OWNER, zoneWithCandidate(), OWNER)).toEqual([
      OWNER,
      CHILD,
      CANDIDATE,
    ]);
  });
});

describe("admission code copy feedback", () => {
  it("labels all four modes, keeping idle empty", () => {
    expect(admissionCodeCopyStatus("idle")).toBe("");
    const copying = admissionCodeCopyStatus("copying");
    const copied = admissionCodeCopyStatus("copied");
    const manual = admissionCodeCopyStatus("manual");
    expect(copying).not.toBe("");
    expect(copied).not.toBe("");
    expect(manual).not.toBe("");
    expect(copied).not.toBe(manual);
    expect(copied).toContain("Send it to the candidate");
    expect(copied).toContain("Join a zone");
    expect(manual).toContain("manually");
  });

  it("tells the owner where the candidate uses the code", () => {
    expect(admissionCodeCopyAnnouncement("idle")).toBe("");
    expect(admissionCodeCopyAnnouncement("copied")).toContain(
      "Send it to the candidate",
    );
    expect(admissionCodeCopyAnnouncement("copied")).toContain("Join a zone");
    expect(admissionCodeCopyAnnouncement("manual")).toContain(
      "manual copying",
    );
  });
});

/**
 * A tiny DOM stand-in. The suite runs in the node environment (see
 * `vite.config.ts`), so the panel's DOM wiring is exercised against just the
 * properties it touches. The ids are read from the module so a new `byId` call
 * cannot silently escape the fixture.
 */
class FakeElement {
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  value = "";
  textContent = "";
  title = "";
  type = "";
  tabIndex = 0;
  dateTime = "";
  className = "";
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<
    string,
    Array<(event: { preventDefault(): void }) => void>
  >();
  private readonly classes = new Set<string>();
  readonly classList = {
    toggle: (token: string, force?: boolean): void => {
      const on = force ?? !this.classes.has(token);
      if (on) this.classes.add(token);
      else this.classes.delete(token);
    },
    contains: (token: string): boolean => this.classes.has(token),
  };

  constructor(
    readonly tagName: string,
    readonly id = "",
  ) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  addEventListener(
    type: string,
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault: () => {} });
    }
  }

  focus(): void {}

  select(): void {}

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.dispatch("close");
  }

  hasClass(token: string): boolean {
    return this.classes.has(token) || this.className.split(/\s+/).includes(token);
  }

  querySelectorAll<T>(selector: string): T[] {
    const token = selector.startsWith(".") ? selector.slice(1) : selector;
    const matches: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        const hit = selector.startsWith(".")
          ? child.hasClass(token)
          : child.tagName === token;
        if (hit) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches as T[];
  }
}

const PANEL_IDS = [
  ...new Set(
    [
      ...readFileSync(
        new URL("./requests-panel.ts", import.meta.url),
        "utf-8",
      ).matchAll(/byId<[^>]*>\(\s*"([^"]+)"\s*,?\s*\)/g),
    ].map((match) => match[1]!),
  ),
];

interface PanelFixture {
  panel: ReturnType<typeof createRequestsPanel>;
  elements: Map<string, FakeElement>;
  announce: ReturnType<typeof vi.fn>;
  clipboard: { writeText: ReturnType<typeof vi.fn> };
  setZone(zone: StateV3): void;
  setRoom(state: CandidateStateV1): void;
}

function setupPanel(
  initialZone: StateV3,
  initialRoom: CandidateStateV1,
): PanelFixture {
  let zone = initialZone;
  let room = initialRoom;
  const announce = vi.fn();
  const clipboard = {
    writeText: vi.fn(async (_text: string): Promise<void> => {}),
  };
  vi.stubGlobal("navigator", { clipboard });

  const transport = {
    read: async (): Promise<CandidateStateV1 | null> => room,
    ensure: async (): Promise<void> => {},
    request: async (): Promise<CandidateStateV1> => room,
    setAccepting: async (): Promise<CandidateStateV1> => room,
    dismiss: async (): Promise<CandidateStateV1> => room,
    updateMembership: async (): Promise<CandidateStateV1> => room,
    sendMessage: async (): Promise<CandidateStateV1> => room,
    sealEpoch: async () => ({ epoch: 1, secrets: [] }),
    openEpoch: async () => new Uint8Array(),
    epochKeyFor: async () => null,
    roomIdFor: () => "room",
    close: () => {},
  } as unknown as CandidateTransport;

  const elements = new Map<string, FakeElement>();
  for (const id of PANEL_IDS) elements.set(id, new FakeElement("div", id));
  const doc = {
    activeElement: null as FakeElement | null,
    getElementById: (id: string): FakeElement | null =>
      elements.get(id) ?? null,
    createElement: (tag: string): FakeElement => new FakeElement(tag),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);

  const panel = createRequestsPanel({
    transport,
    ownId: () => OWNER,
    readOwnZone: async () => zone,
    ownAddress: async () => "",
    openAdmit: async () => {},
    announce,
  });

  return {
    panel,
    elements,
    announce,
    clipboard,
    setZone(next) {
      zone = next;
    },
    setRoom(next) {
      room = next;
    },
  };
}

function invitedRoom(): CandidateStateV1 {
  return roomState([membership(1, [OWNER, CHILD, CANDIDATE])]);
}

/**
 * Open the panel, start an interview with the candidate, then refresh into the
 * written designation. Starting the interview sets the panel's `invited`
 * fallback, which is what keeps the admitted candidate visible once the slot
 * makes them a zone child.
 */
async function openWithAdmission(fixture: PanelFixture): Promise<void> {
  fixture.panel.open();
  await vi.waitFor(() => {
    const candidateButton = fixture.elements
      .get("requests-list")!
      .querySelectorAll<FakeElement>(".requests-interview")[0];
    expect(candidateButton).toBeDefined();
    expect(candidateButton!.disabled).toBe(false);
  });

  fixture.setRoom(invitedRoom());
  fixture.elements
    .get("requests-list")!
    .querySelectorAll<FakeElement>(".requests-interview")[0]!
    .dispatch("click");
  await vi.waitFor(() => {
    expect(fixture.elements.get("interview-section")!.hidden).toBe(false);
    expect(fixture.elements.get("interview-candidate")!.textContent).toBe(
      shortRequester(CANDIDATE),
    );
  });

  fixture.setZone(zoneWithCandidate());
  fixture.panel.refresh();
  await vi.waitFor(() => {
    expect(fixture.elements.get("admission-code-section")!.hidden).toBe(false);
  });
}

function requestFromCandidate(): CandidateStateV1 {
  return state([
    request({ requester: CANDIDATE, sig: "4".repeat(128) }),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admission code copy action", () => {
  it("appears when a slot names the candidate and disappears when it does not", async () => {
    const fixture = setupPanel(zoneWithChild(), requestFromCandidate());
    await openWithAdmission(fixture);

    const section = fixture.elements.get("admission-code-section")!;
    const copy = fixture.elements.get("admission-code-copy")!;
    expect(section.hidden).toBe(false);
    expect(copy.hidden).toBe(false);
    expect(copy.disabled).toBe(false);
    expect(
      fixture.elements.get("admission-code-result")!.textContent,
    ).toBe("Slot 2 written");

    fixture.setZone(zoneWithChild());
    fixture.panel.refresh();
    await vi.waitFor(() => {
      expect(fixture.elements.get("admission-code-section")!.hidden).toBe(
        true,
      );
    });
    expect(
      fixture.elements.get("admission-code-copy-status")!.textContent,
    ).toBe("");
    expect(fixture.elements.get("admission-code-field")!.hidden).toBe(true);
  });

  it("copies a portable code, shows Copied and announces it", async () => {
    const fixture = setupPanel(zoneWithChild(), requestFromCandidate());
    await openWithAdmission(fixture);

    fixture.elements.get("admission-code-copy")!.dispatch("click");
    await vi.waitFor(() => {
      expect(fixture.clipboard.writeText).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(
        fixture.elements.get("admission-code-copy-status")!.textContent,
      ).toContain("Copied.");
    });

    const copied = fixture.clipboard.writeText.mock.calls[0]![0] as string;
    expect(copied.startsWith("tally-admit1.")).toBe(true);
    expect(fixture.announce).toHaveBeenCalledWith(
      admissionCodeCopyAnnouncement("copied"),
    );
  });

  it("falls back to a readonly field when the clipboard is unavailable", async () => {
    const fixture = setupPanel(zoneWithChild(), requestFromCandidate());
    await openWithAdmission(fixture);
    fixture.clipboard.writeText.mockRejectedValueOnce(
      new Error("clipboard blocked"),
    );

    fixture.elements.get("admission-code-copy")!.dispatch("click");
    const input = fixture.elements.get("admission-code-input")!;
    await vi.waitFor(() => {
      expect(input.value.startsWith("tally-admit1.")).toBe(true);
    });
    expect(fixture.elements.get("admission-code-field")!.hidden).toBe(false);
    expect(
      fixture.elements.get("admission-code-copy-status")!.textContent,
    ).toContain("manually");
    expect(fixture.announce).toHaveBeenCalledWith(
      admissionCodeCopyAnnouncement("manual"),
    );

    // The next attempt clears the stale manual value.
    fixture.elements.get("admission-code-copy")!.dispatch("click");
    await vi.waitFor(() => {
      expect(input.value).toBe("");
      expect(fixture.elements.get("admission-code-field")!.hidden).toBe(true);
    });
  });

  it("builds a code that decodes back to the written slot record", async () => {
    const fixture = setupPanel(zoneWithChild(), requestFromCandidate());
    await openWithAdmission(fixture);

    fixture.elements.get("admission-code-copy")!.dispatch("click");
    await vi.waitFor(() => {
      expect(fixture.clipboard.writeText).toHaveBeenCalledTimes(1);
    });

    const copied = fixture.clipboard.writeText.mock.calls[0]![0] as string;
    const decoded = decodeAdmissionCode(copied);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const record = zoneWithCandidate().slots[1]!;
    expect(decoded.code.slot).toBe(1);
    expect(decoded.code.seq).toBe(record.seq);
    expect(decoded.code.entry.contact).toBe(record.entry!.contact);
    expect(decoded.code.sig).toBe(record.sig);
  });

  it("keeps the code available after Finish admission", async () => {
    const fixture = setupPanel(zoneWithChild(), requestFromCandidate());
    await openWithAdmission(fixture);

    // Finish admission directly through the confirmation action; the fixture
    // transport keeps the written slot in the owner's zone.
    fixture.elements.get("interview-finish-confirm-button")!.dispatch("click");
    await vi.waitFor(() => {
      expect(fixture.elements.get("interview-section")!.hidden).toBe(true);
    });

    const section = fixture.elements.get("admission-code-section")!;
    expect(section.hidden).toBe(false);
    expect(
      fixture.elements.get("admission-code-result")!.textContent,
    ).toBe("Slot 2 written");

    fixture.elements.get("admission-code-copy")!.dispatch("click");
    await vi.waitFor(() => {
      expect(fixture.clipboard.writeText).toHaveBeenCalledTimes(1);
    });

    const copied = fixture.clipboard.writeText.mock.calls[0]![0] as string;
    const decoded = decodeAdmissionCode(copied);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.code.slot).toBe(1);
    expect(decoded.code.entry.contact).toBe(CANDIDATE);
  });
});
