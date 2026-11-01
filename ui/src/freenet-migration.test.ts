/**
 * ensureState's legacy-probe hook (the v5→v6 migration seam).
 *
 * The board cannot read a v5 address book from the decoded state: `decodeState`
 * upgrades v5 by dropping `contacts`. So the probe hands the raw bytes to the
 * caller's upgrade hook, and the PUT happens only after the hook resolves. This
 * suite pins both halves with the real NumberContract.
 */
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeApi = vi.hoisted(() => ({
  states: new Map<string, number[]>(),
  puts: [] as Array<{ state: number[] }>,
  connected: [] as unknown[],
  /** Instance key a PUT lands on (the active generation for these tests). */
  activeKey: "",
}));

vi.mock("@freenetorg/freenet-stdlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@freenetorg/freenet-stdlib")>();

  class FakeWsApi {
    private readonly handler: {
      onOpen: () => void;
      onContractGet: (response: { key: unknown; state: number[] }) => void;
    };

    constructor(
      _url: URL,
      handler: {
        onOpen: () => void;
        onContractGet: (response: { key: unknown; state: number[] }) => void;
      },
      _token: string,
    ) {
      this.handler = handler;
      fakeApi.connected.push(this);
      queueMicrotask(() => this.handler.onOpen());
    }

    async get(request: { key: { encode: () => string } }): Promise<{ state: number[] }> {
      const key = request.key.encode();
      const state = fakeApi.states.get(key);
      if (!state) throw new Error("Contract not found");
      return { state };
    }

    async put(request: { wrappedState: number[] }): Promise<void> {
      const state = Array.from(request.wrappedState);
      fakeApi.puts.push({ state });
      fakeApi.states.set(fakeApi.activeKey, state);
    }

    async subscribe(): Promise<void> {}
    async disconnect(): Promise<void> {}
  }

  return { ...actual, FreenetWsApi: FakeWsApi };
});

const V5_HASH = "5YKHJAKaLcMoKaM9nhXJweGytK6CpDvsskEzPfFJ3jrg";
const PARAMETERS = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const WASM = Uint8Array.from([0, 97, 115, 109, 1, 2, 3, 4]);
const ACTIVE_HASH = bs58.encode(blake3(WASM));

const OWNER = "11".repeat(32);
const ALICE = "22".repeat(32);
const SIG = "a".repeat(128);

const LEGACY = JSON.stringify({
  v: 5,
  parent: { seq: 0, userId: null, sig: null },
  contacts: {
    seq: 1,
    entries: [
      { label: "Alice", userId: ALICE },
      { label: "My board", userId: OWNER },
    ],
    sig: SIG,
  },
  payments: { seq: 0, settled: [], entry: null, sig: null },
  adjustments: { seq: 0, entries: [], sig: null },
  slots: Array.from({ length: 8 }, () => ({
    seq: 0,
    entry: null,
    sig: null,
  })),
});

function encodeStateJson(state: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(state));
}

async function moduleHashes(): Promise<{ active: string; legacyKeys: string[] }> {
  const { deriveContractKey } = await import("./freenet");
  return {
    active: deriveContractKey(ACTIVE_HASH, PARAMETERS).encode(),
    legacyKeys: [deriveContractKey(V5_HASH, PARAMETERS).encode()],
  };
}

describe("NumberContract.ensureState legacy upgrade", () => {
  beforeEach(async () => {
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:8080" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => WASM.slice().buffer,
      })),
    );
    fakeApi.states.clear();
    fakeApi.puts.length = 0;
    fakeApi.connected.length = 0;

    const { active, legacyKeys } = await moduleHashes();
    fakeApi.activeKey = active;
    fakeApi.states.set(legacyKeys[0], Array.from(encodeStateJson(JSON.parse(LEGACY))));
  });

  it("hands the raw legacy bytes to the upgrade hook and PUTs its result", async () => {
    const { NumberContract } = await import("./freenet");
    const { emptyChildNames } = await import("./state");
    const contract = new NumberContract(ACTIVE_HASH, "/number_contract.wasm");
    await contract.connect();

    const seen: Array<{ text: string; codeHash: string }> = [];
    const state = await contract.ensureState(
      PARAMETERS,
      [V5_HASH],
      async (raw, codeHash) => {
        seen.push({
          text: new TextDecoder().decode(raw),
          codeHash,
        });
        return {
          v: 6,
          selfName: { seq: 1, name: "My board", sig: SIG },
          parent: { seq: 0, userId: null, sig: null },
          childNames: emptyChildNames(),
          payments: { seq: 0, settled: [], entry: null, sig: null },
          adjustments: { seq: 0, entries: [], sig: null },
          slots: Array.from({ length: 8 }, () => ({
            seq: 0,
            entry: null,
            sig: null,
          })),
        } as unknown as Awaited<ReturnType<typeof contract.ensureState>>;
      },
    );

    // The hook saw the v5 encoding, contacts included, plus its generation.
    expect(seen).toHaveLength(1);
    expect(seen[0].codeHash).toBe(V5_HASH);
    expect(JSON.parse(seen[0].text).contacts.entries).toHaveLength(2);

    expect(fakeApi.puts).toHaveLength(1);
    const putState = JSON.parse(new TextDecoder().decode(Uint8Array.from(fakeApi.puts[0].state)));
    expect(putState.v).toBe(6);
    expect(putState).not.toHaveProperty("contacts");
    expect(putState.selfName).toEqual({ seq: 1, name: "My board", sig: SIG });
    expect(state.v).toBe(6);
    expect(state.selfName.name).toBe("My board");

    contract.close();
  });

  it("never PUTs when the upgrade hook throws", async () => {
    const { NumberContract } = await import("./freenet");
    const contract = new NumberContract(ACTIVE_HASH, "/number_contract.wasm");
    await contract.connect();

    await expect(
      contract.ensureState(PARAMETERS, [V5_HASH], async () => {
        throw new Error("the delegate refused the address book");
      }),
    ).rejects.toThrow(/delegate refused the address book/);

    expect(fakeApi.puts).toHaveLength(0);
    // The legacy instance is still the only copy.
    const { legacyKeys } = await moduleHashes();
    expect(fakeApi.states.get(legacyKeys[0])).toEqual(
      Array.from(encodeStateJson(JSON.parse(LEGACY))),
    );

    contract.close();
  });

  it("publishes a whole state for the legacy-ahead heal", async () => {
    const { NumberContract } = await import("./freenet");
    const { emptyChildNames, emptyState } = await import("./state");
    const contract = new NumberContract(ACTIVE_HASH, "/number_contract.wasm");
    await contract.connect();

    const state = emptyState();
    state.selfName = { seq: 1, name: "Healed", sig: SIG };
    state.childNames = emptyChildNames();

    await contract.publishState(PARAMETERS, state);

    expect(fakeApi.puts).toHaveLength(1);
    const putState = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(fakeApi.puts[0].state)),
    );
    expect(putState.v).toBe(6);
    expect(putState.selfName).toEqual({ seq: 1, name: "Healed", sig: SIG });
    expect(putState).not.toHaveProperty("contacts");

    contract.close();
  });
});
