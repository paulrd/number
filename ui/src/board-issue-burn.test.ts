/**
 * v5 issue/burn flow on OnlineBoard, with a fake transport like delegate.test.
 *
 * `issueOrBurn` must sign the slot write first, then the adjustments record
 * that names it, and submit both in one v5 delta.
 */
import { describe, expect, it, vi } from "vitest";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  DelegateResponseT,
  OutboundDelegateMsgT,
  OutboundDelegateMsgType,
} from "@freenetorg/freenet-stdlib/host-response";
import type { ClientRequestT } from "@freenetorg/freenet-stdlib/client-request";
import type { DelegateResponse } from "@freenetorg/freenet-stdlib";
import type { OnlineBoard } from "./board";
import type { Delta, StateV3 } from "./state";
import { I64_MAX } from "./state";
import { LEGACY_CONTRACT_CODE_HASHES } from "./migrations";

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
  const { mergeDelta: merge, emptyState: empty } = await import("./state");

  class FakeNumberContract {
    static instances: FakeNumberContract[] = [];
    readonly callbacks: Record<string, (...args: never[]) => unknown>;
    state = empty();
    contractKeyBase58 = "fake-contract-key";
    readonly codeHashBase58: string;
    readonly wasmUrl: string;
    readonly deltas: Delta[] = [];

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
    async ensureState(): Promise<ReturnType<typeof empty>> {
      return this.state;
    }
    async getState(): Promise<ReturnType<typeof empty>> {
      return this.state;
    }
    async subscribe(): Promise<void> {}
    async updateDelta(delta: Delta): Promise<void> {
      this.deltas.push(delta);
      this.state = merge(this.state, delta);
    }
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
const ACTIVE = "BLbDu5FZUdSfLrGejhuaWw5iMJBo3j3TVRyPv9rfJyMA";
const CONTACT_A = "11".repeat(32);

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

function slot(value: bigint, seq = 3) {
  return {
    seq,
    entry: { value, contact: CONTACT_A, unit: "kg", note: "rent" },
    sig: SIG,
  };
}

interface Harness {
  board: OnlineBoard;
  contract: { state: StateV3; deltas: Delta[] };
  sent: Record<string, unknown>[];
}

async function harness(
  mutate: (state: StateV3) => void,
  counters: {
    nextSeq?: number[];
    adjustmentsNextSeq?: number;
    adjustmentSeqOffset?: number;
  } = {},
): Promise<Harness> {
  const { OnlineBoard } = await import("./board");
  const { NumberContract } = await import("./freenet");
  const sent: Record<string, unknown>[] = [];
  const nextSeq = counters.nextSeq ?? [1, 1, 1, 1, 1, 1, 1, 1];
  let adjustmentsNextSeq = counters.adjustmentsNextSeq ?? 1;

  const board = new OnlineBoard(
    {
      contractCodeHash: ACTIVE,
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

  const fake = NumberContract as unknown as {
    instances: Array<{ state: StateV3; deltas: Delta[] }>;
  };

  fakeTransport.handler = (request, callbacks) => {
    const payload = sentPayload([request as ClientRequestT]);
    sent.push(payload);
    let reply: object;
    if (payload.cmd === "status") {
      reply = {
        ok: true,
        hasSeed: true,
        pubkey: CONTACT_A,
        nextSeq,
        contactsNextSeq: 1,
        parentNextSeq: 1,
        paymentsNextSeq: 1,
        adjustmentsNextSeq,
        configured: true,
        codeHashes: [ACTIVE, ...LEGACY_CONTRACT_CODE_HASHES],
        matchedCodeHash: ACTIVE,
        address: "",
        autoAdvance: true,
        maxAmount: 1_000_000,
        subscriptions: [],
        lastScan: 0,
        lastError: null,
        audit: [],
      };
    } else if (payload.cmd === "identity") {
      reply = {
        ok: true,
        pubkey: CONTACT_A,
        nextSeq,
        contactsNextSeq: 1,
        parentNextSeq: 1,
        paymentsNextSeq: 1,
        adjustmentsNextSeq,
      };
    } else if (payload.cmd === "configure") {
      reply = { ok: true, configured: true, matchedCodeHash: ACTIVE };
    } else if (payload.cmd === "signAdjustment") {
      const returned = Number(payload.seq) + (counters.adjustmentSeqOffset ?? 0);
      adjustmentsNextSeq = returned + 1;
      reply = { ok: true, seq: returned, sig: SIG };
    } else if (payload.cmd === "sign") {
      reply = { ok: true, sig: SIG };
    } else {
      reply = { ok: true };
    }
    (callbacks.onDelegateResponse as
      | ((value: DelegateResponse) => void)
      | undefined)?.(response(reply));
  };

  await board.start();
  await vi.waitFor(() => {
    expect(sent.some((payload) => payload.cmd === "configure")).toBe(true);
  });

  const contract = fake.instances[fake.instances.length - 1];
  mutate(contract.state);
  return { board, contract, sent };
}

describe("OnlineBoard.issueOrBurn", () => {
  it("issues by signing the slot first, then the adjustment log, in one delta", async () => {
    const { board, contract, sent } = await harness(
      (state) => {
        state.slots[0] = slot(1000n, 3);
      },
      { nextSeq: [5, 1, 1, 1, 1, 1, 1, 1], adjustmentsNextSeq: 3 },
    );

    await board.issueOrBurn(0, 250n, "issue");

    const sign = sent.find(
      (payload) => payload.cmd === "sign" && payload.slot === 0,
    );
    expect(sign).toEqual({
      cmd: "sign",
      slot: 0,
      seq: 5,
      entry: { value: 1250, contact: CONTACT_A, unit: "kg", note: "rent" },
    });

    const adjust = sent.find((payload) => payload.cmd === "signAdjustment");
    expect(adjust).toEqual({
      cmd: "signAdjustment",
      seq: 3,
      entries: [
        {
          slot: 0,
          slotSeq: 5,
          delta: 250,
          postValue: 1250,
          note: "issue",
        },
      ],
    });

    const deltas = (contract as unknown as { deltas: Delta[] }).deltas;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].v).toBe(5);
    expect(deltas[0].slots).toEqual([
      {
        i: 0,
        seq: 5,
        entry: { value: 1250n, contact: CONTACT_A, unit: "kg", note: "rent" },
        sig: SIG,
      },
    ]);
    expect(deltas[0].adjustments).toEqual({
      seq: 3,
      entries: [
        {
          slot: 0,
          slotSeq: 5,
          delta: 250n,
          postValue: 1250n,
          note: "issue",
        },
      ],
      sig: SIG,
    });

    expect(board.currentState?.slots[0].entry?.value).toBe(1250n);
    expect(board.identity?.nextSeq[0]).toBe(6);
    expect(board.identity?.adjustmentsNextSeq).toBe(4);

    // The delegate is reconfigured against the active v5 hash plus legacy.
    const configure = [...sent]
      .reverse()
      .find((payload) => payload.cmd === "configure");
    expect(configure?.codeHashes).toEqual([
      ACTIVE,
      ...LEGACY_CONTRACT_CODE_HASHES,
    ]);

    board.close();
  });

  it("burns and clamps at zero", async () => {
    const { board, contract } = await harness((state) => {
      state.slots[1] = slot(500n, 3);
    });

    await board.issueOrBurn(1, -400n, "burn");
    expect(board.currentState?.slots[1].entry?.value).toBe(100n);

    await expect(board.issueOrBurn(1, -200n, "too much")).rejects.toThrow(
      /below zero/,
    );
    const deltas = (contract as unknown as { deltas: Delta[] }).deltas;
    expect(deltas).toHaveLength(1);
    expect(board.currentState?.slots[1].entry?.value).toBe(100n);

    board.close();
  });

  it("rejects an i64 overflow and non-bigint/non-zero deltas before signing", async () => {
    const { board, contract, sent } = await harness((state) => {
      state.slots[2] = slot(I64_MAX, 3);
    });
    const before = sent.length;

    await expect(board.issueOrBurn(2, 1n, "overflow")).rejects.toThrow(
      /signed 64-bit/,
    );
    await expect(board.issueOrBurn(2, 0n, "zero")).rejects.toThrow(/non-zero/);
    // A non-bigint must be rejected, not silently truncated to 1.
    await expect(
      board.issueOrBurn(2, 1.5 as unknown as bigint, "fraction"),
    ).rejects.toThrow(/bigint/);
    await expect(board.issueOrBurn(8, 1n, "slot")).rejects.toThrow(/0\.\.7/);
    expect(sent).toHaveLength(before);
    expect((contract as unknown as { deltas: Delta[] }).deltas).toHaveLength(0);

    board.close();
  });

  it("refuses an empty slot", async () => {
    const { board, sent } = await harness(() => {});
    await expect(board.issueOrBurn(0, 100n, "issue")).rejects.toThrow(
      /empty slot/,
    );
    expect(sent.some((payload) => payload.cmd === "signAdjustment")).toBe(
      false,
    );
    board.close();
  });

  it("uses the seq returned by signAdjustment for the delta record", async () => {
    const { board, contract, sent } = await harness(
      (state) => {
        state.slots[0] = slot(1000n, 3);
      },
      { adjustmentSeqOffset: 2 },
    );

    await board.issueOrBurn(0, 100n, "issue");
    const adjust = sent.find((payload) => payload.cmd === "signAdjustment");
    expect(adjust?.seq).toBe(1);

    const deltas = (contract as unknown as { deltas: Delta[] }).deltas;
    expect(deltas[0].adjustments?.seq).toBe(3);
    expect(board.identity?.adjustmentsNextSeq).toBe(4);
    board.close();
  });

  it("uses the delegate's adjustments counter when it is ahead of the log", async () => {
    const { board, sent } = await harness(
      (state) => {
        state.slots[2] = slot(100n, 4);
        state.adjustments = {
          seq: 2,
          entries: [
            {
              slot: 2,
              slotSeq: 1,
              delta: 5n,
              postValue: 5n,
              note: null,
            },
          ],
          sig: SIG,
        };
      },
      { nextSeq: [1, 1, 3, 1, 1, 1, 1, 1], adjustmentsNextSeq: 7 },
    );

    await board.issueOrBurn(2, 25n, "use counter");
    const adjust = sent.find((payload) => payload.cmd === "signAdjustment");
    expect(adjust).toEqual({
      cmd: "signAdjustment",
      seq: 7,
      entries: [
        {
          slot: 2,
          slotSeq: 1,
          delta: 5,
          postValue: 5,
          note: null,
        },
        {
          slot: 2,
          slotSeq: 5,
          delta: 25,
          postValue: 125,
          note: "use counter",
        },
      ],
    });
    expect(board.identity?.adjustmentsNextSeq).toBe(8);
    board.close();
  });
});
