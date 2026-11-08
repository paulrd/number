import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OfflineCandidateTransport,
  offlineCandidateEpochKey,
} from "./candidate-offline";
import {
  candidateNoteToText,
  candidateRequestId,
  latestCandidateMembership,
} from "./candidate-state";
import { bytesToHex, isLowerHex } from "./util";

const OWNER = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const encoder = new TextEncoder();

describe("OfflineCandidateTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("read/ensure returns an empty, stable state", async () => {
    const transport = new OfflineCandidateTransport(OWNER);

    await transport.ensure(OWNER);
    const state = await transport.read(OWNER);

    expect(state).toEqual({
      v: 1,
      memberships: [],
      messages: [],
      requests: [],
      dismissals: [],
      config: null,
    });
    expect(await transport.read(OWNER)).toBe(state);
  });

  it("queues a requester-signed ask and a second distinct ask", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transport = new OfflineCandidateTransport(OWNER);

    const first = await transport.request(OWNER, {
      wantCell: "003",
      note: "let me in",
    });
    expect(first.requests).toHaveLength(1);
    const request = first.requests[0];
    expect(request.requester).toBe(OWNER);
    expect(request.want_cell).toBe("003");
    expect(candidateNoteToText(request.note)).toBe("let me in");
    expect(isLowerHex(request.sig, 128)).toBe(true);
    const firstId = candidateRequestId(request);
    expect(isLowerHex(firstId, 32)).toBe(true);

    vi.setSystemTime(1_000);
    const second = await transport.request(OWNER, {
      wantCell: "01",
      note: "again",
    });
    expect(second.requests).toHaveLength(2);
    const ids = second.requests.map(candidateRequestId);
    expect(ids).toContain(firstId);
    expect(new Set(ids).size).toBe(2);
  });

  it("increments the config seq on each owner write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const transport = new OfflineCandidateTransport(OWNER);

    const first = await transport.setAccepting(OWNER, true);
    expect(first.config).toMatchObject({ seq: 1, accepting: true });
    expect(isLowerHex(first.config!.sig, 128)).toBe(true);

    const second = await transport.setAccepting(OWNER, false);
    expect(second.config).toMatchObject({ seq: 2, accepting: false });
    expect(second.config!.sig).not.toBe(first.config!.sig);
  });

  it("dismisses a request and keeps the dismissal", async () => {
    const transport = new OfflineCandidateTransport(OWNER);
    const requested = await transport.request(OWNER, {
      wantCell: "0",
      note: "dismiss me",
    });
    const id = candidateRequestId(requested.requests[0]);

    const state = await transport.dismiss(OWNER, id);
    expect(state.requests).toHaveLength(0);
    expect(state.dismissals).toHaveLength(1);
    expect(state.dismissals[0].id).toBe(id);
    expect(isLowerHex(state.dismissals[0].sig, 128)).toBe(true);
  });

  it("refuses owner-only writes from another key", async () => {
    const transport = new OfflineCandidateTransport(OWNER);

    await expect(
      transport.setAccepting(OTHER, true),
    ).rejects.toMatchObject({ code: "not-owner" });
    await expect(
      transport.dismiss(OTHER, "ab".repeat(16)),
    ).rejects.toMatchObject({ code: "not-owner" });
  });

  it("round-trips membership and messages at the latest epoch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const transport = new OfflineCandidateTransport(OWNER);

    const joined = await transport.updateMembership(OWNER, [OTHER, OWNER]);
    const membership = latestCandidateMembership(joined);
    expect(membership).not.toBeNull();
    expect(membership!.seq).toBe(1);
    expect(membership!.members).toEqual([OWNER, OTHER].sort());
    expect(isLowerHex(membership!.sig, 128)).toBe(true);

    const first = await transport.sendMessage(
      OWNER,
      encoder.encode("hello candidate"),
    );
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].author).toBe(OWNER);
    expect(first.messages[0].epoch).toBe(1);
    expect(first.messages[0].seq).toBe(1);
    expect(first.messages[0].body).toBe(
      bytesToHex(encoder.encode("hello candidate")),
    );

    vi.setSystemTime(4_000);
    const second = await transport.sendMessage(OWNER, encoder.encode("again"));
    expect(second.messages).toHaveLength(2);
    const again = second.messages.find(
      (item) => item.body === bytesToHex(encoder.encode("again")),
    );
    expect(again?.seq).toBe(2);
    expect(isLowerHex(again!.sig, 128)).toBe(true);
  });

  it("seals deterministic epoch keys and structurally valid blobs", async () => {
    const transport = new OfflineCandidateTransport(OWNER);

    const sealed = await transport.sealEpoch(OWNER, 2, [OWNER, OTHER]);
    expect(sealed.epochKey).toEqual(offlineCandidateEpochKey(OWNER, 2));
    expect(sealed.nextMembershipSeq).toBe(2);
    expect(sealed.secrets.map((secret) => secret.recipient)).toEqual([
      OWNER,
      OTHER,
    ]);
    for (const secret of sealed.secrets) {
      expect(isLowerHex(secret.blob, 93 * 2)).toBe(true);
      expect(secret.blob.startsWith("01")).toBe(true);
    }

    const opened = await transport.openEpoch(
      OWNER,
      2,
      sealed.secrets[0].blob,
    );
    expect(opened).toEqual(sealed.epochKey);
    await expect(transport.openEpoch(OWNER, 2, "01")).rejects.toMatchObject({
      code: "crypto",
    });
  });
});
