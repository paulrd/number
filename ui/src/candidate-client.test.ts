import { blake3 } from "@noble/hashes/blake3";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  DelegateResponseT,
  OutboundDelegateMsgT,
  OutboundDelegateMsgType,
} from "@freenetorg/freenet-stdlib/host-response";
import type { ClientRequestT } from "@freenetorg/freenet-stdlib/client-request";
import type { DelegateResponse } from "@freenetorg/freenet-stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DelegateClient,
  type CandidateConfigSignRequest,
  type CandidateDismissalSignRequest,
  type CandidateRequestSignRequest,
} from "./delegate";
import {
  OnlineCandidateTransport,
  CandidateError,
  candidateInstanceId,
  candidateParameters,
  type CandidateConnection,
  type CandidateSigner,
} from "./candidate-client";
import {
  candidateRequestId,
  encodeCandidateState,
  mergeCandidateStates,
  parseCandidateDelta,
  parseCandidateState,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import {
  roomInstanceId,
  type RoomSignMembershipRequest,
  type RoomSignMessageRequest,
} from "./room-client";
import {
  RoomCryptoError,
  decryptRoomBody,
  readRoomBody,
  roomEpochKeyCache,
} from "./room-crypto";
import { bytesToHex } from "./util";

// The published room artifact from `published/room/manifest.json`; the
// candidate derives a different instance from the same code hash.
const PINNED_CODE_HASH = "DWAtsfi3Ed5kGNZiXFxfU1AfjfGe83iAwb1BWHttFBPM";
const PINNED_CODE_HASH_HEX =
  "b9c54630c1e7ecac451a833e7e4d81739cc62832e6d88373b3c089e81e85c638";
const OWNER = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const OTHER = "66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a";
const EMPTY_SIG = "aa".repeat(64);
const MESSAGE_SIG = "cd".repeat(64);

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

function membership(
  members: string[],
  seq = 1,
): CandidateStateV1["memberships"][number] {
  return { seq, members, secrets: [], sig: EMPTY_SIG };
}

function ask(index: number): CandidateRequestV1 {
  return {
    requester: OTHER,
    want_cell: "003",
    time: 1_000 + index,
    note: "6c6574206d6520696e",
    sig: (index + 1).toString(16).padStart(128, "0"),
  };
}

class FakeConnection implements CandidateConnection {
  state: CandidateStateV1 | null;
  readonly puts: {
    parameters: Uint8Array;
    wasm: Uint8Array;
    state: Uint8Array;
  }[] = [];
  readonly updates: ReturnType<typeof parseCandidateDelta>[] = [];
  closed = false;

  constructor(state: CandidateStateV1 | null) {
    this.state = state ? (JSON.parse(JSON.stringify(state)) as CandidateStateV1) : null;
  }

  async get(): Promise<Uint8Array | null> {
    return this.state ? encodeCandidateState(this.state) : null;
  }

  async put(
    parameters: Uint8Array,
    wasm: Uint8Array,
    initialState: Uint8Array,
  ): Promise<void> {
    this.puts.push({ parameters, wasm, state: initialState });
    this.state = parseCandidateState(initialState);
  }

  async update(_parameters: Uint8Array, delta: Uint8Array): Promise<void> {
    const parsed = parseCandidateDelta(delta);
    this.updates.push(parsed);
    if (parsed.full) {
      this.state = parsed.full;
      return;
    }
    const base = this.state ?? emptyState();
    this.state = mergeCandidateStates(base, {
      v: 1,
      memberships: parsed.memberships ?? [],
      messages: parsed.messages ?? [],
      requests: parsed.requests ?? [],
      dismissals: parsed.dismissals ?? [],
      config: parsed.config ?? null,
    });
  }

  close(): void {
    this.closed = true;
  }
}

class FakeSigner implements CandidateSigner {
  readonly membershipRequests: RoomSignMembershipRequest[] = [];
  readonly messageRequests: RoomSignMessageRequest[] = [];
  readonly requestRequests: CandidateRequestSignRequest[] = [];
  readonly dismissalRequests: CandidateDismissalSignRequest[] = [];
  readonly configRequests: CandidateConfigSignRequest[] = [];
  author = OWNER;
  messageSeq = 1;
  private counter = 0;

  private nextSig(): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(128, "0");
  }

  async signRoomMembership(request: RoomSignMembershipRequest): Promise<string> {
    this.membershipRequests.push(request);
    return EMPTY_SIG;
  }

  async signRoomMessage(
    request: RoomSignMessageRequest,
  ): Promise<{ author: string; seq: number; sig: string }> {
    this.messageRequests.push(request);
    return { author: this.author, seq: this.messageSeq, sig: MESSAGE_SIG };
  }

  async signCandidateRequest(request: CandidateRequestSignRequest) {
    this.requestRequests.push(request);
    const sig = this.nextSig();
    const requestId = candidateRequestId({
      requester: this.author,
      want_cell: request.wantCell,
      time: request.time,
      note: request.note,
      sig,
    });
    return { requester: this.author, requestId, sig };
  }

  async signCandidateDismissal(request: CandidateDismissalSignRequest) {
    this.dismissalRequests.push(request);
    return { id: request.id, sig: this.nextSig() };
  }

  async signCandidateConfig(request: CandidateConfigSignRequest) {
    this.configRequests.push(request);
    return { seq: request.seq, sig: this.nextSig() };
  }
}

const EPOCH_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

/** v12+ signer: deterministic epoch key, structurally valid secret blobs. */
class EncryptingSigner extends FakeSigner implements CandidateSigner {
  readonly sealRequests: {
    roomId: string;
    owner: string;
    tag: string;
    epoch: number;
    members: string[];
  }[] = [];
  readonly openRequests: {
    roomId: string;
    owner: string;
    tag: string;
    epoch: number;
    blob: string;
  }[] = [];
  nextMembershipSeq: number | null = null;
  version = 13;

  delegateVersion(): number {
    return this.version;
  }

  authorId(): string {
    return this.author;
  }

  async sealRoomEpoch(request: {
    roomId: string;
    owner: string;
    tag: string;
    epoch: number;
    members: string[];
  }) {
    this.sealRequests.push(request);
    return {
      version: 1 as const,
      epoch: request.epoch,
      epochKey: EPOCH_KEY,
      nextMembershipSeq: this.nextMembershipSeq ?? request.epoch,
      secrets: request.members.map((recipient) => ({
        recipient,
        blob: "bb".repeat(93),
      })),
    };
  }

  async openRoomSecret(request: {
    roomId: string;
    owner: string;
    tag: string;
    epoch: number;
    blob: string;
  }) {
    this.openRequests.push(request);
    return {
      version: 1 as const,
      epoch: request.epoch,
      recipient: this.author,
      epochKey: EPOCH_KEY,
    };
  }
}

describe("candidate derivation", () => {
  it("builds 36-byte ZCR1 parameters", () => {
    const parameters = candidateParameters(OWNER);
    expect(parameters).toHaveLength(36);
    expect(bytesToHex(parameters.slice(0, 4))).toBe("5a435231");
    expect(bytesToHex(parameters.slice(4))).toBe(OWNER);
  });

  it("derives a ZCR1 instance distinct from the ZMR1 room", () => {
    const candidate = candidateInstanceId(OWNER, PINNED_CODE_HASH);
    const room = roomInstanceId(OWNER, PINNED_CODE_HASH);
    expect(candidate.id).not.toBe(room.id);
    expect(candidate.key.encode()).toBe(candidate.id);
    expect(bytesToHex(candidate.key.codePart() ?? new Uint8Array())).toBe(
      PINNED_CODE_HASH_HEX,
    );
    expect(candidateInstanceId(OWNER, PINNED_CODE_HASH).id).toBe(candidate.id);
    expect(candidateInstanceId(OTHER, PINNED_CODE_HASH).id).not.toBe(
      candidate.id,
    );
  });
});

describe("online candidate transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    roomEpochKeyCache.clear();
  });

  it("refuses a bundled WASM whose hash is not pinned", async () => {
    const connection = new FakeConnection(null);
    const transport = new OnlineCandidateTransport(new FakeSigner(), {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));

    await expect(transport.ensure(OWNER)).rejects.toMatchObject({
      code: "wasm",
    });
    expect(connection.puts).toHaveLength(0);
  });

  it("PUTs the empty state with config null when the hash matches", async () => {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 2, 3, 4]);
    const connection = new FakeConnection(null);
    const transport = new OnlineCandidateTransport(new FakeSigner(), {
      connection,
      codeHashBytes: blake3(wasm),
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      arrayBuffer: async () => wasm.buffer,
    }));

    await transport.ensure(OWNER);
    expect(connection.puts).toHaveLength(1);
    const put = connection.puts[0];
    expect(bytesToHex(put.parameters)).toBe(
      bytesToHex(candidateParameters(OWNER)),
    );
    expect(put.parameters).toHaveLength(36);
    expect(parseCandidateState(put.state)).toEqual(emptyState());
  });

  it("writes a signed ask and confirms the derived request id", async () => {
    const connection = new FakeConnection(emptyState());
    const signer = new FakeSigner();
    const transport = new OnlineCandidateTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    const after = await transport.request(OWNER, {
      wantCell: "003",
      note: "let me in",
    });

    expect(signer.requestRequests[0]).toMatchObject({
      owner: OWNER,
      wantCell: "003",
      note: bytesToHex(new TextEncoder().encode("let me in")),
    });
    expect(after.requests).toHaveLength(1);
    expect(connection.updates).toHaveLength(1);
    expect(connection.updates[0].requests).toHaveLength(1);
  });

  it("increments the config seq and confirms the write", async () => {
    const connection = new FakeConnection({
      ...emptyState(),
      config: { seq: 2, accepting: true, sig: EMPTY_SIG },
    });
    const signer = new FakeSigner();
    const transport = new OnlineCandidateTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    const after = await transport.setAccepting(OWNER, false);
    expect(signer.configRequests[0]).toMatchObject({
      owner: OWNER,
      seq: 3,
      accepting: false,
    });
    expect(after.config).toMatchObject({ seq: 3, accepting: false });
  });

  it("dismisses a request and removes it from the confirmed state", async () => {
    const record = ask(0);
    const requestId = candidateRequestId(record);
    const connection = new FakeConnection({
      ...emptyState(),
      requests: [record],
    });
    const signer = new FakeSigner();
    const transport = new OnlineCandidateTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    const after = await transport.dismiss(OWNER, requestId);
    expect(signer.dismissalRequests[0]).toMatchObject({
      owner: OWNER,
      id: requestId,
    });
    expect(after.dismissals.map((item) => item.id)).toEqual([requestId]);
    expect(after.requests).toEqual([]);
  });

  it("surfaces owner-only signing failures as errors", async () => {
    const connection = new FakeConnection(emptyState());
    const signer = Object.assign(new FakeSigner(), {
      authorId: () => OTHER,
    });
    const transport = new OnlineCandidateTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });
    await expect(transport.setAccepting(OWNER, false)).rejects.toMatchObject({
      code: "not-owner",
    });
    await expect(
      transport.dismiss(OWNER, candidateRequestId(ask(0))),
    ).rejects.toMatchObject({ code: "not-owner" });

    const offline = new OnlineCandidateTransport(
      Object.assign(new FakeSigner(), {
        signCandidateConfig: async () => {
          throw new Error("delegate offline");
        },
      }),
      { connection, codeHashBase58: PINNED_CODE_HASH },
    );
    await expect(offline.setAccepting(OWNER, false)).rejects.toBeInstanceOf(
      CandidateError,
    );
    await expect(offline.setAccepting(OWNER, false)).rejects.toMatchObject({
      code: "sign",
    });
  });

  it("encrypts messages with the ZCR1 AAD and epoch tag", async () => {
    const connection = new FakeConnection({
      ...emptyState(),
      memberships: [membership([OWNER], 1)],
    });
    const signer = new EncryptingSigner();
    const transport = new OnlineCandidateTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    const sealed = await transport.updateMembership(OWNER, [OWNER], {
      encrypt: true,
    });
    const epoch = sealed.memberships[sealed.memberships.length - 1].seq;
    expect(signer.sealRequests[0].tag).toBe("ZCR1");
    expect(signer.membershipRequests[0].tag).toBe("ZCR1");

    const after = await transport.sendMessage(
      OWNER,
      new TextEncoder().encode("secret hello"),
    );
    const sent = after.messages[0];
    expect(sent.epoch).toBe(epoch);
    expect(sent.body.startsWith("01")).toBe(true);
    expect(signer.messageRequests[0].tag).toBe("ZCR1");

    const roomId = transport.roomIdFor(OWNER);
    await expect(
      readRoomBody(
        EPOCH_KEY,
        { roomId, owner: OWNER, author: OWNER, epoch, tag: "ZCR1" },
        sent.body,
      ),
    ).resolves.toEqual({ kind: "encrypted", text: "secret hello" });
    await expect(
      decryptRoomBody(
        EPOCH_KEY,
        { roomId, owner: OWNER, author: OWNER, epoch },
        sent.body,
      ),
    ).rejects.toBeInstanceOf(RoomCryptoError);
  });
});

function response(payload: object): DelegateResponse {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));
  const application = new ApplicationMessageT(bytes, [], false);
  const outbound = new OutboundDelegateMsgT(
    OutboundDelegateMsgType.common_ApplicationMessage,
    application,
  );
  return new DelegateResponseT(null, [outbound]) as unknown as DelegateResponse;
}

function sentPayload(sent: ClientRequestT[]): Record<string, unknown> {
  const request = sent[sent.length - 1] as unknown as {
    clientRequest: {
      delegateRequest: {
        inbound: Array<{ inbound: { payload: number[] } }>;
      };
    };
  };
  const bytes = request.clientRequest.delegateRequest.inbound[0].inbound.payload;
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
}

describe("delegate candidate request shapes", () => {
  const KEY_BYTES = Array.from({ length: 32 }, () => 1);
  const CODE_HASH_BYTES = Array.from({ length: 32 }, () => 2);
  const PARAMS_BYTES = Array.from({ length: 32 }, () => 3);

  function makeClient(reply: object): {
    client: DelegateClient;
    sent: ClientRequestT[];
  } {
    const sent: ClientRequestT[] = [];
    let client!: DelegateClient;
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    return { client, sent };
  }

  it("sends signCandidateRequest and parses the derived id", async () => {
    const { client, sent } = makeClient({
      ok: true,
      requester: OTHER,
      requestId: "ab".repeat(16),
      sig: EMPTY_SIG,
    });

    const signed = await client.signCandidateRequest({
      owner: OWNER,
      time: 1_762_500_000_001,
      wantCell: "003",
      note: bytesToHex(new TextEncoder().encode("let me in")),
    });

    expect(sentPayload(sent)).toEqual({
      cmd: "signCandidateRequest",
      owner: OWNER,
      time: 1_762_500_000_001,
      wantCell: "003",
      note: bytesToHex(new TextEncoder().encode("let me in")),
    });
    expect(signed).toEqual({
      requester: OTHER,
      requestId: "ab".repeat(16),
      sig: EMPTY_SIG,
    });
  });

  it("sends signCandidateDismissal", async () => {
    const { client, sent } = makeClient({
      ok: true,
      id: "ab".repeat(16),
      sig: EMPTY_SIG,
    });

    const signed = await client.signCandidateDismissal({
      owner: OWNER,
      id: "ab".repeat(16),
    });

    expect(sentPayload(sent)).toEqual({
      cmd: "signCandidateDismissal",
      owner: OWNER,
      id: "ab".repeat(16),
    });
    expect(signed).toEqual({ id: "ab".repeat(16), sig: EMPTY_SIG });
  });

  it("sends signCandidateConfig", async () => {
    const { client, sent } = makeClient({
      ok: true,
      seq: 4,
      sig: EMPTY_SIG,
    });

    const signed = await client.signCandidateConfig({
      owner: OWNER,
      seq: 4,
      accepting: false,
    });

    expect(sentPayload(sent)).toEqual({
      cmd: "signCandidateConfig",
      owner: OWNER,
      seq: 4,
      accepting: false,
    });
    expect(signed).toEqual({ seq: 4, sig: EMPTY_SIG });
  });

  it("rejects malformed candidate inputs before sending", async () => {
    const { client, sent } = makeClient({ ok: true, sig: EMPTY_SIG });
    await expect(
      client.signCandidateRequest({
        owner: OWNER,
        time: 1,
        wantCell: "8",
        note: "",
      }),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signCandidateDismissal({ owner: OWNER, id: "zz" }),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signCandidateConfig({ owner: OWNER, seq: 0, accepting: true }),
    ).rejects.toMatchObject({ code: "Protocol" });
    expect(sent).toHaveLength(0);
  });
});
