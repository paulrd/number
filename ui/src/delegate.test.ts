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
import type { Entry } from "./state";

const KEY_BYTES = Array.from({ length: 32 }, () => 1);
const CODE_HASH_BYTES = Array.from({ length: 32 }, () => 2);
const PARAMS_BYTES = Array.from({ length: 32 }, () => 3);
const SIG = "a".repeat(128);

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
    };
    const identity = await client.identity();
    expect(identity).toEqual({
      pubkey: "ab".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(sent).toHaveLength(1);

    // The node checks BLAKE3(code hash || params) against the delegate key.
    const sentRequest = sent[0] as unknown as {
      clientRequest: { delegateRequest: { params: number[] } };
    };
    expect(sentRequest.clientRequest.delegateRequest.params).toEqual(PARAMS_BYTES);

    const entry: Entry = {
      value: 12,
      label: "steps",
      unit: null,
      note: null,
    };
    reply = { ok: true, sig: SIG };
    await expect(client.sign(3, 7, entry)).resolves.toBe(SIG);
    expect(sent).toHaveLength(2);
  });

  it("handles status, export, and import responses", async () => {
    let reply: object = {};
    let client!: DelegateClient;
    client = new DelegateClient(
      () => client.handleResponse(response(reply)),
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
    };
    await expect(client.status()).resolves.toEqual({
      hasSeed: true,
      identity: {
        pubkey: "ab".repeat(32),
        nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
      },
    });

    reply = {
      ok: true,
      seed: "cd".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
    };
    await expect(client.exportSecrets()).resolves.toEqual({
      seed: "cd".repeat(32),
      nextSeq: [1, 2, 3, 4, 5, 6, 7, 8],
    });

    reply = { ok: true };
    await expect(
      client.importSecrets("ef".repeat(32), [1, 1, 1, 1, 1, 1, 1, 1]),
    ).resolves.toBeUndefined();
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
      client.sign(0, 1, {
        value: 1,
        label: null,
        unit: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: "Protocol" });
  });
});
