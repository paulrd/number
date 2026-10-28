import { describe, expect, it } from "vitest";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  DelegateResponseT,
  OutboundDelegateMsgT,
  OutboundDelegateMsgType,
} from "@freenetorg/freenet-stdlib/host-response";
import type { ClientRequestT } from "@freenetorg/freenet-stdlib/client-request";
import type { DelegateResponse } from "@freenetorg/freenet-stdlib";
import {
  DelegateClient,
  DelegateError,
  isMissingDelegateError,
  parseDelegatePayloads,
} from "./delegate";
import { MAX_CONTACTS, type Contact, type Entry } from "./state";
import type { PaymentEntry } from "./payments";

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

    reply = { ok: true, hasSeed: false };
    await expect(client.status()).resolves.toEqual({
      hasSeed: false,
      identity: null,
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
      },
    });

    reply = {
      ok: true,
      seed: "cd".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 5,
      parentNextSeq: 8,
      paymentsNextSeq: 10,
    };
    await expect(client.exportSecrets()).resolves.toEqual({
      seed: "cd".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      contactsNextSeq: 5,
      parentNextSeq: 8,
      paymentsNextSeq: 10,
    });

    reply = { ok: true };
    await expect(
      client.importSecrets("ef".repeat(32), [1, 1, 1, 1, 1, 1, 1, 1], 6, 9, 11),
    ).resolves.toBeUndefined();
    expect(sentPayload(sent)).toEqual({
      cmd: "import",
      seed: "ef".repeat(32),
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
      contactsNextSeq: 6,
      parentNextSeq: 9,
      paymentsNextSeq: 11,
    });

    // The default counters are 1 for callers that omit them.
    await client.importSecrets("ef".repeat(32), [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(sentPayload(sent)).toMatchObject({
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
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
