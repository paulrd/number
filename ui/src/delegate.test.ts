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
    );

    const pending = client.identity();
    client.handleHostError("Delegate not found: number-delegate");

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DelegateError);
    expect(error).toMatchObject({ code: "Missing" });
    expect(isMissingDelegateError(error)).toBe(true);
  });

  it("rejects a missing build configuration before sending", async () => {
    const client = new DelegateClient(() => {}, [], []);
    await expect(client.identity()).rejects.toMatchObject({ code: "Config" });
  });

  it("rejects malformed signing responses", async () => {
    const client = new DelegateClient(
      () => client.handleResponse(response({ ok: true, sig: "not-a-sig" })),
      KEY_BYTES,
      CODE_HASH_BYTES,
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
