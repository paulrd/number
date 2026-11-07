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
  type RoomMembershipSignRequest,
} from "./delegate";
import {
  OnlineRoomTransport,
  RoomError,
  roomInstanceId,
  roomParameters,
  type RoomConnection,
  type RoomSigner,
  type RoomSignMembershipRequest,
  type RoomSignMessageRequest,
} from "./room-client";
import {
  encodeRoomState,
  parseRoomDelta,
  parseRoomState,
  type RoomDeltaV1,
  type RoomStateV1,
} from "./room-state";
import { bytesToHex } from "./util";

// The published room artifact from `published/room/manifest.json`.
const PINNED_CODE_HASH = "DWAtsfi3Ed5kGNZiXFxfU1AfjfGe83iAwb1BWHttFBPM";
const PINNED_CODE_HASH_HEX =
  "b9c54630c1e7ecac451a833e7e4d81739cc62832e6d88373b3c089e81e85c638";
// Golden owner/member from `fixtures/rooms/golden_v1.json`.
const OWNER = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const OTHER = "66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a";
// Computed once from BLAKE3(code_hash_bytes || b"ZMR1" || owner_vk).
const GOLDEN_INSTANCE = "9aYjgvx7v5ThiwYDKoKkottXRN6N2MefY4camU4DLFHX";
const GOLDEN_INSTANCE_HEX =
  "7f758bcf1711eb9c3a37f3ae5c658ae896b451235af3eb5b2a6614519891940e";
const EMPTY_SIG = "aa".repeat(64);
const MESSAGE_SIG = "cd".repeat(64);

class FakeConnection implements RoomConnection {
  state: RoomStateV1 | null;
  readonly puts: {
    parameters: Uint8Array;
    wasm: Uint8Array;
    state: Uint8Array;
  }[] = [];
  readonly updates: RoomDeltaV1[] = [];
  closed = false;

  constructor(state: RoomStateV1 | null) {
    this.state = state ? (JSON.parse(JSON.stringify(state)) as RoomStateV1) : null;
  }

  async get(): Promise<Uint8Array | null> {
    return this.state ? encodeRoomState(this.state) : null;
  }

  async put(
    parameters: Uint8Array,
    wasm: Uint8Array,
    initialState: Uint8Array,
  ): Promise<void> {
    this.puts.push({ parameters, wasm, state: initialState });
    this.state = parseRoomState(initialState);
  }

  async update(_parameters: Uint8Array, delta: Uint8Array): Promise<void> {
    const parsed = parseRoomDelta(delta);
    this.updates.push(parsed);
    const base = this.state ?? { v: 1, memberships: [], messages: [] };
    this.state = {
      v: 1,
      memberships: [...base.memberships, ...(parsed.memberships ?? [])],
      messages: [...base.messages, ...(parsed.messages ?? [])],
    };
  }

  close(): void {
    this.closed = true;
  }
}

class FakeSigner implements RoomSigner {
  readonly membershipRequests: RoomSignMembershipRequest[] = [];
  readonly messageRequests: RoomSignMessageRequest[] = [];
  author = OWNER;
  messageSeq = 1;

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
}

function membership(members: string[], seq = 1): RoomStateV1["memberships"][number] {
  return { seq, members, secrets: [], sig: EMPTY_SIG };
}

describe("room derivation", () => {
  it("builds 36-byte ZMR1 parameters", () => {
    const parameters = roomParameters(OWNER);
    expect(parameters).toHaveLength(36);
    expect(bytesToHex(parameters.slice(0, 4))).toBe("5a4d5231");
    expect(bytesToHex(parameters.slice(4))).toBe(OWNER);
  });

  it("matches the golden room instance id", () => {
    const room = roomInstanceId(OWNER, PINNED_CODE_HASH);
    expect(room.id).toBe(GOLDEN_INSTANCE);
    expect(room.key.encode()).toBe(GOLDEN_INSTANCE);
    expect(bytesToHex(room.key.codePart() ?? new Uint8Array())).toBe(
      PINNED_CODE_HASH_HEX,
    );
    expect(
      bytesToHex(Uint8Array.from(room.key.instance?.data ?? [])),
    ).toBe(GOLDEN_INSTANCE_HEX);
    expect(room.keyT.instance?.data).toEqual(
      Array.from(Uint8Array.from(Buffer.from(GOLDEN_INSTANCE_HEX, "hex"))),
    );
  });

  it("is stable per owner and different per owner", () => {
    const first = roomInstanceId(OWNER, PINNED_CODE_HASH);
    const again = roomInstanceId(OWNER, PINNED_CODE_HASH);
    const other = roomInstanceId(OTHER, PINNED_CODE_HASH);
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
  });
});

describe("online room transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes the next membership seq and verifies the applied record", async () => {
    const connection = new FakeConnection({ v: 1, memberships: [], messages: [] });
    const signer = new FakeSigner();
    const transport = new OnlineRoomTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    const first = await transport.updateMembership(OWNER, [OWNER, OTHER]);
    expect(first.memberships).toHaveLength(1);
    expect(first.memberships[0].seq).toBe(1);
    expect(first.memberships[0].members).toEqual([OTHER, OWNER]);
    expect(first.memberships[0].secrets).toEqual([]);
    expect(signer.membershipRequests[0]).toMatchObject({
      roomId: GOLDEN_INSTANCE,
      owner: OWNER,
      tag: "ZMR1",
      seq: 1,
      secrets: [],
    });

    const second = await transport.updateMembership(OWNER, [OWNER]);
    expect(second.memberships.map((record) => record.seq)).toEqual([1, 2]);
    expect(signer.membershipRequests[1].seq).toBe(2);
    expect(connection.updates).toHaveLength(2);
  });

  it("rejects a membership that omits the owner before signing", async () => {
    const connection = new FakeConnection({ v: 1, memberships: [], messages: [] });
    const signer = new FakeSigner();
    const transport = new OnlineRoomTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    await expect(transport.updateMembership(OWNER, [OTHER])).rejects.toMatchObject({
      code: "not-member",
    });
    expect(signer.membershipRequests).toHaveLength(0);
    expect(connection.updates).toHaveLength(0);
  });

  it("refuses to send a message when the owner is not in the latest epoch", async () => {
    const connection = new FakeConnection({
      v: 1,
      memberships: [membership([OTHER])],
      messages: [],
    });
    const signer = new FakeSigner();
    const transport = new OnlineRoomTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    await expect(
      transport.sendMessage(OWNER, new TextEncoder().encode("hi")),
    ).rejects.toMatchObject({ code: "not-member" });
    expect(signer.messageRequests).toHaveLength(0);
    expect(connection.updates).toHaveLength(0);
  });

  it("signs a message at the latest epoch and re-reads", async () => {
    const connection = new FakeConnection({
      v: 1,
      memberships: [membership([OWNER], 2)],
      messages: [],
    });
    const signer = new FakeSigner();
    signer.messageSeq = 7;
    const transport = new OnlineRoomTransport(signer, {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });

    const after = await transport.sendMessage(
      OWNER,
      new TextEncoder().encode("hello"),
    );
    expect(signer.messageRequests[0]).toMatchObject({
      roomId: GOLDEN_INSTANCE,
      owner: OWNER,
      tag: "ZMR1",
      epoch: 2,
      body: bytesToHex(new TextEncoder().encode("hello")),
    });
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]).toMatchObject({
      author: OWNER,
      epoch: 2,
      seq: 7,
      body: bytesToHex(new TextEncoder().encode("hello")),
      sig: MESSAGE_SIG,
    });
  });

  it("rejects a bundled WASM whose hash is not pinned", async () => {
    const connection = new FakeConnection(null);
    const transport = new OnlineRoomTransport(new FakeSigner(), {
      connection,
      codeHashBase58: PINNED_CODE_HASH,
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));

    await expect(transport.ensure(OWNER)).rejects.toMatchObject({ code: "wasm" });
    expect(connection.puts).toHaveLength(0);
  });

  it("PUTs the empty state with 36-byte parameters when the hash matches", async () => {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 2, 3, 4]);
    const connection = new FakeConnection(null);
    const transport = new OnlineRoomTransport(new FakeSigner(), {
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
    expect(bytesToHex(put.parameters)).toBe(bytesToHex(roomParameters(OWNER)));
    expect(put.parameters).toHaveLength(36);
    expect(parseRoomState(put.state)).toEqual({
      v: 1,
      memberships: [],
      messages: [],
    });
  });

  it("wraps signer failures as RoomError sign", async () => {
    const connection = new FakeConnection({ v: 1, memberships: [], messages: [] });
    const transport = new OnlineRoomTransport(
      {
        async signRoomMembership(): Promise<string> {
          throw new Error("delegate offline");
        },
        async signRoomMessage() {
          throw new Error("delegate offline");
        },
      },
      { connection, codeHashBase58: PINNED_CODE_HASH },
    );

    await expect(transport.updateMembership(OWNER, [OWNER])).rejects.toBeInstanceOf(
      RoomError,
    );
    await expect(transport.updateMembership(OWNER, [OWNER])).rejects.toMatchObject({
      code: "sign",
    });
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

describe("delegate room request shapes", () => {
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

  it("sends signRoomMembership with the contract's field names", async () => {
    const { client, sent } = makeClient({ ok: true, sig: EMPTY_SIG });
    const request: RoomMembershipSignRequest = {
      roomId: GOLDEN_INSTANCE,
      owner: OWNER,
      tag: "ZMR1",
      seq: 3,
      members: [OTHER, OWNER],
      secrets: [],
    };

    const sig = await client.signRoomMembership(request);
    expect(sig).toBe(EMPTY_SIG);
    expect(sentPayload(sent)).toEqual({
      cmd: "signRoomMembership",
      roomId: GOLDEN_INSTANCE,
      owner: OWNER,
      tag: "ZMR1",
      seq: 3,
      members: [OTHER, OWNER],
      secrets: [],
    });
  });

  it("sends signRoomMessage and matches the roomMessage response branch", async () => {
    const { client, sent } = makeClient({
      ok: true,
      author: OWNER,
      seq: 9,
      sig: MESSAGE_SIG,
    });

    const signed = await client.signRoomMessage({
      roomId: GOLDEN_INSTANCE,
      owner: OWNER,
      tag: "ZMR1",
      epoch: 2,
      time: 1_762_500_000_000,
      body: bytesToHex(new TextEncoder().encode("hi")),
    });

    expect(signed).toEqual({ author: OWNER, seq: 9, sig: MESSAGE_SIG });
    expect(sentPayload(sent)).toEqual({
      cmd: "signRoomMessage",
      roomId: GOLDEN_INSTANCE,
      owner: OWNER,
      tag: "ZMR1",
      epoch: 2,
      time: 1_762_500_000_000,
      body: bytesToHex(new TextEncoder().encode("hi")),
    });
  });
});
