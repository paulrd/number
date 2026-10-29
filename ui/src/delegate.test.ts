import { describe, expect, it, vi } from "vitest";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  DelegateResponseT,
  OutboundDelegateMsgT,
  OutboundDelegateMsgType,
} from "@freenetorg/freenet-stdlib/host-response";
import type { ClientRequestT } from "@freenetorg/freenet-stdlib/client-request";
import type { DelegateResponse } from "@freenetorg/freenet-stdlib";
import {
  DEFAULT_MAX_AMOUNT,
  DelegateClient,
  DelegateError,
  delegateNeverScanned,
  isDelegateStatusStale,
  isMissingDelegateError,
  parseDelegatePayloads,
} from "./delegate";
import { MAX_CONTACTS, type Adjustment, type Contact, type Entry } from "./state";
import type { PaymentEntry } from "./payments";
import { LEGACY_CONTRACT_CODE_HASHES } from "./migrations";

// Board-level configure-on-connect is tested here with a fake transport: no
// WebSocket or real node is involved.
const fakeTransport = vi.hoisted(() => ({
  handler: null as
    | null
    | ((
        request: unknown,
        callbacks: Record<string, (...args: never[]) => unknown>,
      ) => void),
}));

vi.mock("./freenet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./freenet")>();
  const { emptyState } = await import("./state");

  class FakeNumberContract {
    static instances: FakeNumberContract[] = [];
    readonly callbacks: Record<string, (...args: never[]) => unknown>;
    state = emptyState();
    contractKeyBase58 = "fake-contract-key";
    readonly codeHashBase58: string;
    readonly wasmUrl: string;

    constructor(
      codeHashBase58: string,
      wasmUrl: string,
      callbacks: Record<string, (...args: never[]) => unknown> = {},
    ) {
      this.codeHashBase58 = codeHashBase58;
      this.wasmUrl = wasmUrl;
      this.callbacks = callbacks;
      FakeNumberContract.instances.push(this);
    }

    async connect(): Promise<void> {}
    async ensureState(): Promise<ReturnType<typeof emptyState>> {
      return this.state;
    }
    async getState(): Promise<ReturnType<typeof emptyState>> {
      return this.state;
    }
    async subscribe(): Promise<void> {}
    async updateDelta(): Promise<void> {}
    sendClientRequest(request: ClientRequestT): void {
      fakeTransport.handler?.(request, this.callbacks);
    }
    close(): void {}
  }

  return { ...actual, NumberContract: FakeNumberContract };
});

const KEY_BYTES = Array.from({ length: 32 }, () => 1);
const CODE_HASH_BYTES = Array.from({ length: 32 }, () => 2);
const PARAMS_BYTES = Array.from({ length: 32 }, () => 3);
const SIG = "a".repeat(128);

const CONTACT_A = "11".repeat(32);
const CONTACT_B = "22".repeat(32);
const CONTACT_HEX = "ab".repeat(32);

function response(payload: object): DelegateResponse {
  const bytes = Array.from(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const application = new ApplicationMessageT(bytes, [], false);
  const outbound = new OutboundDelegateMsgT(
    OutboundDelegateMsgType.common_ApplicationMessage,
    application,
  );
  return new DelegateResponseT(
    null,
    [outbound],
  ) as unknown as DelegateResponse;
}

/** Unpack the JSON body of the most recently sent application request. */
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

function entry(value: bigint = 12n): Entry {
  return { value, contact: CONTACT_A, unit: null, note: null };
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

function payment(overrides: Partial<PaymentEntry> = {}): PaymentEntry {
  return {
    id: "0123456789abcdef0123456789abcdef",
    src: CONTACT_A,
    dst: CONTACT_B,
    amount: 1250n,
    srcAddr: "52",
    dstAddr: "31",
    cursor: 2,
    phase: "forward",
    status: "acted",
    next: CONTACT_A,
    fail: null,
    legs: [{ slot: 1, seq: 4, postValue: 3750n, sig: "5a".repeat(64) }],
    ...overrides,
  };
}

describe("delegate transport", () => {
  it("sends JSON requests and parses identity/sign responses", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];

    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    reply = {
      ok: true,
      pubkey: "ab".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 3,
      parentNextSeq: 4,
      paymentsNextSeq: 5,
    };
    const identity = await client.identity();
    expect(identity).toEqual({
      pubkey: "ab".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 3,
      parentNextSeq: 4,
      paymentsNextSeq: 5,
      adjustmentsNextSeq: 1,
    });
    expect(sent).toHaveLength(1);

    // The node checks BLAKE3(code hash || params) against the delegate key.
    const sentRequest = sent[0] as unknown as {
      clientRequest: { delegateRequest: { params: number[] } };
    };
    expect(sentRequest.clientRequest.delegateRequest.params).toEqual(PARAMS_BYTES);

    reply = { ok: true, sig: SIG };
    await expect(client.sign(3, 7, entry())).resolves.toBe(SIG);
    expect(sent).toHaveLength(2);
    expect(sentPayload(sent)).toEqual({
      cmd: "sign",
      slot: 3,
      seq: 7,
      entry: { value: 12, contact: CONTACT_A, unit: null, note: null },
    });
  });

  it("defaults missing v3/v4 counters to 1 (older delegate)", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    client = new DelegateClient(
      () => client.handleResponse(response(reply)),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    reply = {
      ok: true,
      pubkey: "ab".repeat(32),
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
    };
    await expect(client.identity()).resolves.toMatchObject({
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
    });

    reply = { ok: true, seed: "cd".repeat(32), nextSeq: [1, 1, 1, 1, 1, 1, 1, 1] };
    await expect(client.exportSecrets()).resolves.toMatchObject({
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
    });
  });

  it("rejects a malformed contactsNextSeq", async () => {
    for (const contactsNextSeq of [0, -1, 1.5, "2", null]) {
      let reply: object = {};
      let client!: DelegateClient;
      client = new DelegateClient(
        () => client.handleResponse(response(reply)),
        KEY_BYTES,
        CODE_HASH_BYTES,
        PARAMS_BYTES,
      );
      reply = {
        ok: true,
        pubkey: "ab".repeat(32),
        nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
        contactsNextSeq,
      };
      await expect(client.identity()).rejects.toMatchObject({ code: "Protocol" });
    }
  });

  it("rejects a malformed parentNextSeq", async () => {
    for (const parentNextSeq of [0, -1, 1.5, "2", null, true]) {
      let reply: object = {};
      let client!: DelegateClient;
      client = new DelegateClient(
        () => client.handleResponse(response(reply)),
        KEY_BYTES,
        CODE_HASH_BYTES,
        PARAMS_BYTES,
      );
      reply = {
        ok: true,
        pubkey: "ab".repeat(32),
        nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
        parentNextSeq,
      };
      await expect(client.identity()).rejects.toMatchObject({ code: "Protocol" });
    }
  });

  it("rejects a malformed paymentsNextSeq", async () => {
    for (const paymentsNextSeq of [0, -1, 1.5, "2", null, true]) {
      let reply: object = {};
      let client!: DelegateClient;
      client = new DelegateClient(
        () => client.handleResponse(response(reply)),
        KEY_BYTES,
        CODE_HASH_BYTES,
        PARAMS_BYTES,
      );
      reply = {
        ok: true,
        pubkey: "ab".repeat(32),
        nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
        paymentsNextSeq,
      };
      await expect(client.identity()).rejects.toMatchObject({ code: "Protocol" });
    }
  });

  it("rejects a malformed adjustmentsNextSeq", async () => {
    for (const adjustmentsNextSeq of [0, -1, 1.5, "2", null, true]) {
      let reply: object = {};
      let client!: DelegateClient;
      client = new DelegateClient(
        () => client.handleResponse(response(reply)),
        KEY_BYTES,
        CODE_HASH_BYTES,
        PARAMS_BYTES,
      );
      reply = {
        ok: true,
        pubkey: "ab".repeat(32),
        nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
        adjustmentsNextSeq,
      };
      await expect(client.identity()).rejects.toMatchObject({ code: "Protocol" });
    }
  });

  it("signs a parent link with the signParent command", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    reply = { ok: true, sig: SIG };
    await expect(client.signParent(3, CONTACT_A)).resolves.toBe(SIG);
    expect(sentPayload(sent)).toEqual({
      cmd: "signParent",
      seq: 3,
      userId: CONTACT_A,
    });

    // A null parent clears the link; it is still signed.
    await expect(client.signParent(4, null)).resolves.toBe(SIG);
    expect(sentPayload(sent)).toEqual({ cmd: "signParent", seq: 4, userId: null });
    expect(sent).toHaveLength(2);
  });

  it("rejects malformed signParent arguments before sending", async () => {
    const sent: ClientRequestT[] = [];
    const client = new DelegateClient(
      (request) => sent.push(request),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    await expect(client.signParent(0, CONTACT_A)).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(client.signParent(1.5, CONTACT_A)).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(client.signParent(1, "ab")).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(
      client.signParent(1, CONTACT_HEX.toUpperCase()),
    ).rejects.toMatchObject({ code: "Protocol" });

    expect(sent).toHaveLength(0);
  });

  it("rejects a malformed signParent signature", async () => {
    const client = new DelegateClient(
      () => client.handleResponse(response({ ok: true, sig: "not-a-sig" })),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(client.signParent(1, CONTACT_A)).rejects.toMatchObject({
      code: "Protocol",
    });
  });

  it("signs a payments record with the signPayments command", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    reply = { ok: true, sig: SIG };
    await expect(client.signPayments(6, payment(), [])).resolves.toBe(SIG);
    expect(sentPayload(sent)).toEqual({
      cmd: "signPayments",
      seq: 6,
      settled: [],
      entry: {
        ...payment(),
        amount: 1250,
        legs: [{ ...payment().legs[0], postValue: 3750 }],
      },
    });

    // A null entry is a legal tombstone; settled ids are still covered.
    const settled = ["aa".repeat(16), "bb".repeat(16)];
    await expect(client.signPayments(7, null, settled)).resolves.toBe(SIG);
    expect(sentPayload(sent)).toEqual({
      cmd: "signPayments",
      seq: 7,
      settled,
      entry: null,
    });
    expect(sent).toHaveLength(2);
  });

  it("signs the v5 adjustment log with the signAdjustment command", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    const entries = [adjustment()];
    reply = { ok: true, seq: 1, sig: SIG };
    await expect(client.signAdjustment(1, entries)).resolves.toEqual({
      seq: 1,
      sig: SIG,
    });
    expect(sentPayload(sent)).toEqual({
      cmd: "signAdjustment",
      seq: 1,
      entries: [
        {
          slot: 1,
          slotSeq: 4,
          delta: 100,
          postValue: 3750,
          note: "issue",
        },
      ],
    });
  });

  it("rejects malformed signAdjustment arguments and replies", async () => {
    const sent: ClientRequestT[] = [];
    const client = new DelegateClient(
      (request) => sent.push(request),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(client.signAdjustment(0, [])).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(
      client.signAdjustment(1, [adjustment({ slot: 8 })]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signAdjustment(1, [adjustment({ delta: 0n })]),
    ).rejects.toMatchObject({ code: "Protocol" });
    expect(sent).toHaveLength(0);

    // The delegate's returned seq is authoritative; a lower/absent seq is a
    // protocol error, but a higher one is used for the record.
    const higher = new DelegateClient(
      () => higher.handleResponse(response({ ok: true, seq: 3, sig: SIG })),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(higher.signAdjustment(1, [])).resolves.toEqual({
      seq: 3,
      sig: SIG,
    });

    for (const seq of [0, 1, 1.5, "2", null]) {
      const invalid = new DelegateClient(
        () => invalid.handleResponse(response({ ok: true, seq, sig: SIG })),
        KEY_BYTES,
        CODE_HASH_BYTES,
        PARAMS_BYTES,
      );
      await expect(invalid.signAdjustment(2, [])).rejects.toMatchObject({
        code: "Protocol",
      });
    }

    const badSig = new DelegateClient(
      () => badSig.handleResponse(response({ ok: true, seq: 1, sig: "nope" })),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(badSig.signAdjustment(1, [])).rejects.toMatchObject({
      code: "Protocol",
    });
  });

  it("rejects malformed signPayments arguments before sending", async () => {
    const sent: ClientRequestT[] = [];
    const client = new DelegateClient(
      (request) => sent.push(request),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    await expect(client.signPayments(0, null, [])).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(client.signPayments(1.5, null, [])).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(
      client.signPayments(1, payment({ amount: 0n }), []),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signPayments(1, payment({ id: "AB".repeat(16) }), []),
    ).rejects.toMatchObject({ code: "Protocol" });

    // Malformed settled lists never leave the client.
    await expect(
      client.signPayments(1, null, "aa".repeat(16) as unknown as string[]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signPayments(1, null, ["AA".repeat(16)]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signPayments(1, null, ["aa".repeat(15)]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signPayments(1, null, ["aa".repeat(16), "aa".repeat(16)]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signPayments(
        1,
        null,
        Array.from({ length: 9 }, (_, index) =>
          index.toString(16).padStart(32, "0"),
        ),
      ),
    ).rejects.toMatchObject({ code: "Protocol" });

    expect(sent).toHaveLength(0);
  });

  it("rejects a malformed signPayments signature", async () => {
    const client = new DelegateClient(
      () => client.handleResponse(response({ ok: true, sig: "not-a-sig" })),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(client.signPayments(1, payment(), [])).rejects.toMatchObject({
      code: "Protocol",
    });
  });

  it("handles status, export, and import responses", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    const automationDefaults = {
      configured: false,
      codeHashes: [],
      matchedCodeHash: null,
      address: null,
      autoAdvance: false,
      maxAmount: DEFAULT_MAX_AMOUNT,
      subscriptions: [],
      lastScan: 0,
      lastError: null,
      audit: [],
    };

    reply = { ok: true, hasSeed: false };
    await expect(client.status()).resolves.toEqual({
      hasSeed: false,
      identity: null,
      ...automationDefaults,
    });

    reply = {
      ok: true,
      hasSeed: true,
      pubkey: "ab".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 4,
      parentNextSeq: 7,
      paymentsNextSeq: 6,
    };
    await expect(client.status()).resolves.toEqual({
      hasSeed: true,
      identity: {
        pubkey: "ab".repeat(32),
        nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
        contactsNextSeq: 4,
        parentNextSeq: 7,
        paymentsNextSeq: 6,
        adjustmentsNextSeq: 1,
      },
      ...automationDefaults,
    });

    reply = {
      ok: true,
      seed: "cd".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 5,
      parentNextSeq: 8,
      paymentsNextSeq: 10,
      adjustmentsNextSeq: 12,
    };
    await expect(client.exportSecrets()).resolves.toEqual({
      seed: "cd".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 5,
      parentNextSeq: 8,
      paymentsNextSeq: 10,
      adjustmentsNextSeq: 12,
    });

    reply = { ok: true };
    await expect(
      client.importSecrets(
        "ef".repeat(32),
        [1, 1, 1, 1, 1, 1, 1, 1],
        6,
        9,
        11,
        13,
      ),
    ).resolves.toBeUndefined();
    expect(sentPayload(sent)).toEqual({
      cmd: "import",
      seed: "ef".repeat(32),
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
      contactsNextSeq: 6,
      parentNextSeq: 9,
      paymentsNextSeq: 11,
      adjustmentsNextSeq: 13,
    });

    // The default counters are 1 for callers that omit them.
    await client.importSecrets("ef".repeat(32), [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(sentPayload(sent)).toMatchObject({
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      adjustmentsNextSeq: 1,
    });
  });

  it("rejects a non-positive contactsNextSeq on import", async () => {
    const sent: ClientRequestT[] = [];
    const client = new DelegateClient(
      (request) => sent.push(request),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(
      client.importSecrets("ef".repeat(32), [1, 1, 1, 1, 1, 1, 1, 1], 0),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.importSecrets("ef".repeat(32), [1, 1, 1, 1, 1, 1, 1, 1], 1, 1, 0),
    ).rejects.toMatchObject({ code: "Protocol" });
    expect(sent).toHaveLength(0);
  });

  it("parses the extended v8 auto-advance status", async () => {
    const active = "C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT";
    const legacy = LEGACY_CONTRACT_CODE_HASHES[1];
    let reply: object = {};
    let client!: DelegateClient;
    client = new DelegateClient(
      () => client.handleResponse(response(reply)),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    reply = {
      ok: true,
      hasSeed: true,
      pubkey: "ab".repeat(32),
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      configured: true,
      codeHashes: [active, legacy],
      matchedCodeHash: active,
      address: "52",
      autoAdvance: true,
      maxAmount: 2_500_000,
      subscriptions: ["11".repeat(32)],
      lastScan: 1_760_000_000_000,
      lastError: null,
      audit: [
        { id: "cd".repeat(16), cursor: 1, slots: [2, 3], role: "debit" },
      ],
    };

    await expect(client.status()).resolves.toMatchObject({
      configured: true,
      codeHashes: [active, legacy],
      matchedCodeHash: active,
      address: "52",
      autoAdvance: true,
      maxAmount: 2_500_000,
      subscriptions: ["11".repeat(32)],
      lastScan: 1_760_000_000_000,
      lastError: null,
      audit: [
        { id: "cd".repeat(16), cursor: 1, slots: [2, 3], role: "debit" },
      ],
    });
  });

  it("rejects malformed v8 status fields", async () => {
    for (const field of [
      { codeHashes: ["not base58 !!!"] },
      { codeHashes: ["11".repeat(32)] },
      { matchedCodeHash: "not base58 !!!" },
      { address: "58" },
      { autoAdvance: "yes" },
      { maxAmount: -1 },
      { maxAmount: 1.5 },
      { subscriptions: ["ab"] },
      { lastScan: -1 },
      { lastError: 7 },
      { audit: [{ id: "", cursor: 0, slots: [], role: "debit" }] },
      { audit: [{ id: "aa", cursor: 0, slots: [8], role: "debit" }] },
    ]) {
      let reply: object = {};
      let client!: DelegateClient;
      client = new DelegateClient(
        () => client.handleResponse(response(reply)),
        KEY_BYTES,
        CODE_HASH_BYTES,
        PARAMS_BYTES,
      );
      reply = {
        ok: true,
        hasSeed: true,
        pubkey: "ab".repeat(32),
        nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
        ...field,
      };
      await expect(client.status()).rejects.toMatchObject({ code: "Protocol" });
    }
  });

  it("sends configure and setAutoAdvance with the specified wire shape", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    const active = "C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT";
    const legacy = LEGACY_CONTRACT_CODE_HASHES[1];
    // v8 may acknowledge configuration with the full status shape; the client
    // must bind that to the configure/setAutoAdvance request, not to a status
    // request that is not in flight.
    reply = {
      ok: true,
      hasSeed: true,
      pubkey: "ab".repeat(32),
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
      configured: true,
      matchedCodeHash: active,
      autoAdvance: true,
      maxAmount: 1_000_000,
    };
    await expect(
      client.configure([active, legacy], "52", true, 1_000_000),
    ).resolves.toBeUndefined();
    expect(sentPayload(sent)).toEqual({
      cmd: "configure",
      codeHashes: [active, legacy],
      address: "52",
      autoAdvance: true,
      maxAmount: 1_000_000,
    });

    await expect(client.setAutoAdvance(false, 0)).resolves.toBeUndefined();
    expect(sentPayload(sent)).toEqual({
      cmd: "setAutoAdvance",
      enabled: false,
      maxAmount: 0,
    });
  });

  it("rejects malformed configure/setAutoAdvance arguments before sending", async () => {
    const sent: ClientRequestT[] = [];
    const client = new DelegateClient(
      (request) => sent.push(request),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    const active = "C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT";

    await expect(client.configure([], "")).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(
      client.configure(["not base58 !!!"], ""),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.configure([active, active], ""),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(client.configure([active], "58")).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(
      client.configure([active], "", true, -1),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.configure([active], "", "yes" as unknown as boolean),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.setAutoAdvance(true, 1.5),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.setAutoAdvance("yes" as unknown as boolean),
    ).rejects.toMatchObject({ code: "Protocol" });

    expect(sent).toHaveLength(0);
  });

  it("detects a stale configured hash but not an unconfigured delegate", () => {
    const active = "C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT";
    expect(
      isDelegateStatusStale(
        { configured: false, matchedCodeHash: null },
        active,
      ),
    ).toBe(false);
    expect(
      isDelegateStatusStale(
        { configured: true, matchedCodeHash: active },
        active,
      ),
    ).toBe(false);
    // configure clears the matched hash; null is "not scanned yet", not stale.
    expect(
      isDelegateStatusStale(
        { configured: true, matchedCodeHash: null },
        active,
      ),
    ).toBe(false);
    expect(
      isDelegateStatusStale(
        { configured: true, matchedCodeHash: LEGACY_CONTRACT_CODE_HASHES[1] },
        active,
      ),
    ).toBe(true);
  });

  it("flags an enabled delegate that has never completed a scan", () => {
    expect(
      delegateNeverScanned({ configured: true, autoAdvance: true, lastScan: 0 }),
    ).toBe(true);
    expect(
      delegateNeverScanned({ configured: true, autoAdvance: true, lastScan: 1 }),
    ).toBe(false);
    expect(
      delegateNeverScanned({ configured: true, autoAdvance: false, lastScan: 0 }),
    ).toBe(false);
    expect(
      delegateNeverScanned({ configured: false, autoAdvance: true, lastScan: 0 }),
    ).toBe(false);
  });

  it("configures the delegate on connect, after identity, with the active hash first", async () => {
    const { OnlineBoard } = await import("./board");
    const active = "BLbDu5FZUdSfLrGejhuaWw5iMJBo3j3TVRyPv9rfJyMA";
    const pubkey = "ab".repeat(32);
    const sent: Record<string, unknown>[] = [];

    const status = {
      ok: true,
      hasSeed: true,
      pubkey,
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      configured: false,
      codeHashes: [],
      matchedCodeHash: null,
      address: null,
      autoAdvance: false,
      maxAmount: DEFAULT_MAX_AMOUNT,
      subscriptions: [],
      lastScan: 0,
      lastError: null,
      audit: [],
    };

    const board = new OnlineBoard(
      {
        contractCodeHash: active,
        contractWasmUrl: "/number_contract.wasm",
        delegateWasmUrl: "/number_delegate.wasm",
        delegateKeyBytes: KEY_BYTES,
        delegateCodeHashBytes: CODE_HASH_BYTES,
        delegateParamsBytes: PARAMS_BYTES,
      },
      {
        onStatus: () => {},
        onState: () => {},
        onIdentity: () => {},
        onContractKey: () => {},
        onError: () => {},
      },
    );

    fakeTransport.handler = (request, callbacks) => {
      const payload = sentPayload([request as ClientRequestT]);
      sent.push(payload);
      let reply: object;
      if (payload.cmd === "status") {
        reply = status;
      } else if (payload.cmd === "identity") {
        reply = {
          ok: true,
          pubkey,
          nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
          contactsNextSeq: 1,
          parentNextSeq: 1,
          paymentsNextSeq: 1,
        };
      } else if (payload.cmd === "configure") {
        reply = {
          ok: true,
          configured: true,
          matchedCodeHash: active,
        };
      } else {
        reply = { ok: true };
      }
      (callbacks.onDelegateResponse as
        | ((value: DelegateResponse) => void)
        | undefined)?.(response(reply));
    };

    try {
      await board.start();
      // `start()` configures the delegate after the board is usable (the
      // address walk must not delay first render), so wait for that request
      // before tearing the fake transport down.
      await vi.waitFor(() => {
        expect(sent.some((payload) => payload.cmd === "configure")).toBe(true);
      });
    } finally {
      fakeTransport.handler = null;
    }

    const commands = sent.map((payload) => payload.cmd);
    const configure = sent.find((payload) => payload.cmd === "configure");
    expect(configure).toEqual({
      cmd: "configure",
      codeHashes: [active, ...LEGACY_CONTRACT_CODE_HASHES],
      address: "",
      autoAdvance: true,
      maxAmount: DEFAULT_MAX_AMOUNT,
    });
    expect(commands.indexOf("identity")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("identity")).toBeLessThan(
      commands.indexOf("configure"),
    );

    board.close();
  });

  it("signs contacts with the signContacts command", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    const sent: ClientRequestT[] = [];
    client = new DelegateClient(
      (request) => {
        sent.push(request);
        client.handleResponse(response(reply));
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    reply = { ok: true, sig: SIG };
    const entries: Contact[] = [
      { label: "Alice", userId: CONTACT_A },
      { label: "Bob", userId: CONTACT_B },
    ];
    await expect(client.signContacts(2, entries)).resolves.toBe(SIG);
    expect(sentPayload(sent)).toEqual({
      cmd: "signContacts",
      seq: 2,
      entries,
    });

    // A contacts signature is a `sign` pending request, so a second call works.
    await expect(client.signContacts(3, entries)).resolves.toBe(SIG);
    expect(sent).toHaveLength(2);
  });

  it("rejects malformed signContacts arguments before sending", async () => {
    const sent: ClientRequestT[] = [];
    const client = new DelegateClient(
      (request) => sent.push(request),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    await expect(client.signContacts(0, [])).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(client.signContacts(1.5, [])).rejects.toMatchObject({
      code: "Protocol",
    });
    await expect(
      client.signContacts(1, [{ label: "", userId: CONTACT_A }]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signContacts(1, [{ label: "Alice", userId: CONTACT_HEX.toUpperCase() }]),
    ).rejects.toMatchObject({ code: "Protocol" });
    await expect(
      client.signContacts(1, [
        { label: "Alice", userId: CONTACT_A },
        { label: "Alice", userId: CONTACT_B },
      ]),
    ).rejects.toMatchObject({ code: "Protocol" });

    const tooMany = Array.from({ length: MAX_CONTACTS + 1 }, (_, index) => ({
      label: `c${index}`,
      userId: index.toString(16).padStart(64, "0"),
    }));
    await expect(client.signContacts(1, tooMany)).rejects.toMatchObject({
      code: "Protocol",
    });

    expect(sent).toHaveLength(0);
  });

  it("rejects a malformed signContacts signature", async () => {
    const client = new DelegateClient(
      () => client.handleResponse(response({ ok: true, sig: "not-a-sig" })),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(client.signContacts(1, [])).rejects.toMatchObject({
      code: "Protocol",
    });
  });

  it("extracts only application messages from outbound responses", () => {
    expect(parseDelegatePayloads(response({ ok: true, sig: SIG }))).toEqual([
      { ok: true, sig: SIG },
    ]);

    const empty = new DelegateResponseT(null, []) as unknown as DelegateResponse;
    expect(parseDelegatePayloads(empty)).toEqual([]);
  });

  it("maps a host 'delegate not found' error to DelegateError Missing", async () => {
    const client = new DelegateClient(
      () => {
        // simulate a node that never answers because the delegate is absent
      },
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );

    const pending = client.identity();
    client.handleHostError("Delegate not found: number-delegate");

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DelegateError);
    expect(error).toMatchObject({ code: "Missing" });
    expect(isMissingDelegateError(error)).toBe(true);
  });

  it("rejects a missing build configuration before sending", async () => {
    const client = new DelegateClient(() => {}, [], [], []);
    await expect(client.identity()).rejects.toMatchObject({ code: "Config" });
  });

  it("rejects malformed signing responses", async () => {
    const client = new DelegateClient(
      () => client.handleResponse(response({ ok: true, sig: "not-a-sig" })),
      KEY_BYTES,
      CODE_HASH_BYTES,
      PARAMS_BYTES,
    );
    await expect(
      client.sign(0, 1, entry(1n)),
    ).rejects.toMatchObject({ code: "Protocol" });
  });
});
