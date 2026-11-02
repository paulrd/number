/**
 * v5→v6 board migration on OnlineBoard.
 *
 * The contract code hash changed, so the owner's board now lives in a new
 * instance id. A returning v5 user's slots, parent, payments, adjustments and
 * address book are still in the old instance; this suite pins the order of the
 * migration (delegate address book and signed names first, PUT last) and the
 * rule that a delegate failure aborts the PUT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  DelegateResponseT,
  OutboundDelegateMsgT,
  OutboundDelegateMsgType,
} from "@freenetorg/freenet-stdlib/host-response";
import type { ClientRequestT } from "@freenetorg/freenet-stdlib/client-request";
import type { DelegateResponse } from "@freenetorg/freenet-stdlib";
import type { OnlineBoard } from "./board";
import type { ContactRecord } from "./delegate";
import { emptyState, type Delta, type StateV3 } from "./state";
import { LEGACY_CONTRACT_CODE_HASHES } from "./migrations";
import { contactsImportMarkerKey } from "./board";

const fakeTransport = vi.hoisted(() => ({
  handler: null as
    | null
    | ((
        request: unknown,
        callbacks: Record<string, (...args: never[]) => unknown>,
      ) => void),
}));

const ACTIVE = "BLbDu5FZUdSfLrGejhuaWw5iMJBo3j3TVRyPv9rfJyMA";
const V5_HASH = LEGACY_CONTRACT_CODE_HASHES[0];

vi.mock("./freenet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./freenet")>();
  const { decodeState, emptyState, encodeState, mergeDelta } = await import(
    "./state"
  );

  type Upgrade = (
    raw: Uint8Array,
    codeHash: string,
  ) => Promise<StateV3>;

  class FakeNumberContract {
    static instances: FakeNumberContract[] = [];
    /** Raw legacy bytes keyed by contract code hash (base58). */
    static legacy = new Map<string, Uint8Array>();
    /** A pre-existing v6 board on the active instance (repair path). */
    static activeState: StateV3 | null = null;

    state: StateV3 | null = null;
    contractKeyBase58 = "fake-contract-key";
    readonly puts: Array<{ codeHash: string; state: StateV3; json: string }> =
      [];
    readonly callbacks: Record<string, (...args: never[]) => unknown>;

    constructor(
      readonly codeHashBase58: string,
      readonly wasmUrl: string,
      callbacks: Record<string, (...args: never[]) => unknown> = {},
    ) {
      this.callbacks = callbacks;
      if (
        codeHashBase58 === ACTIVE &&
        FakeNumberContract.activeState !== null
      ) {
        this.state = FakeNumberContract.activeState;
      }
      FakeNumberContract.instances.push(this);
    }

    async connect(): Promise<void> {}

    async ensureState(
      _parameters: Uint8Array,
      legacyHashes: readonly string[] = [],
      upgrade?: Upgrade,
    ): Promise<StateV3> {
      if (this.state) return this.state;
      if (this.codeHashBase58 !== ACTIVE) throw new Error("no such instance");
      for (const codeHash of legacyHashes) {
        const raw = FakeNumberContract.legacy.get(codeHash);
        if (!raw) continue;
        // Mirror the real ensureState: the upgrade runs first and a throw
        // aborts before anything is published.
        const next = upgrade
          ? await upgrade(raw, codeHash)
          : decodeState(raw);
        this.state = next;
        this.puts.push({
          codeHash: this.codeHashBase58,
          state: next,
          json: new TextDecoder().decode(encodeState(next)),
        });
        return next;
      }
      const empty = emptyState();
      this.state = empty;
      this.puts.push({
        codeHash: this.codeHashBase58,
        state: empty,
        json: new TextDecoder().decode(encodeState(empty)),
      });
      return empty;
    }

    async getState(): Promise<StateV3> {
      if (!this.state) throw new Error("no state");
      return this.state;
    }

    async readStateRaw(_parameters: Uint8Array): Promise<Uint8Array> {
      if (this.codeHashBase58 === ACTIVE) {
        if (!this.state) throw new Error("not found");
        return encodeState(this.state);
      }
      const raw = FakeNumberContract.legacy.get(this.codeHashBase58);
      if (!raw) throw new Error("not found");
      return raw;
    }

    async readState(parameters: Uint8Array): Promise<StateV3> {
      return decodeState(await this.readStateRaw(parameters));
    }

    async subscribe(): Promise<void> {}
    async updateDelta(delta: Delta): Promise<void> {
      this.state = mergeDelta(this.state ?? emptyState(), delta);
    }
    /** A whole-state PUT (the legacy-ahead heal). */
    async publishState(
      _parameters: Uint8Array,
      state: StateV3,
    ): Promise<void> {
      this.state = state;
      this.puts.push({
        codeHash: this.codeHashBase58,
        state,
        json: new TextDecoder().decode(encodeState(state)),
      });
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
const SIG_B = "b".repeat(128);
const SIG_C = "c".repeat(128);
const OWNER = "11".repeat(32);
const ALICE = "22".repeat(32);
const BOB = "33".repeat(32);
const UNLABELLED = "44".repeat(32);
const PARENT = "55".repeat(32);
const PAYMENT_ID = "66".repeat(16);

/** A v5 board: contacts, two named slots, a cleared slot, parent, payment, log. */
function legacyV5Json(): string {
  return JSON.stringify({
    v: 5,
    parent: { seq: 2, userId: PARENT, sig: SIG_C },
    contacts: {
      seq: 3,
      entries: [
        { label: "Alice", userId: ALICE },
        { label: "My board", userId: OWNER },
        { label: "Bob", userId: BOB },
      ],
      sig: SIG_B,
    },
    payments: {
      seq: 4,
      settled: [],
      entry: {
        id: PAYMENT_ID,
        src: OWNER,
        dst: ALICE,
        amount: 500,
        srcAddr: "",
        dstAddr: "12",
        cursor: 0,
        phase: "forward",
        status: "offered",
        next: ALICE,
        fail: null,
        legs: [],
      },
      sig: SIG,
    },
    adjustments: {
      seq: 3,
      entries: [
        { slot: 0, slotSeq: 3, delta: 250, postValue: 1250, note: "issue" },
      ],
      sig: SIG_B,
    },
    slots: [
      {
        seq: 3,
        entry: { value: 1250, contact: ALICE, unit: "kg", note: "rent" },
        sig: SIG,
      },
      { seq: 2, entry: null, sig: SIG_B },
      { seq: 0, entry: null, sig: null },
      {
        seq: 1,
        entry: { value: 10, contact: BOB, unit: "kg", note: null },
        sig: SIG_C,
      },
      { seq: 0, entry: null, sig: null },
      {
        seq: 1,
        entry: { value: 20, contact: UNLABELLED, unit: "kg", note: null },
        sig: SIG_C,
      },
      { seq: 0, entry: null, sig: null },
      { seq: 0, entry: null, sig: null },
    ],
  });
}

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

interface HarnessOptions {
  /** Active-instance state that already exists (repair path). */
  activeState?: StateV3;
  /** Seed the delegate's address book before start. */
  book?: ContactRecord[];
  /** Replace the legacy v5 state (defaults to legacyV5Json()). */
  legacy?: string;
  /** Make one delegate command fail like a broken local store. */
  failOn?: string;
  /** 1-based call of `failOn` that fails once (default: the first). */
  failAt?: number;
}

interface Harness {
  board: OnlineBoard;
  sent: Record<string, unknown>[];
  book: ContactRecord[];
  warnings: string[];
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { OnlineBoard } = await import("./board");
  const { NumberContract } = await import("./freenet");
  const fake = NumberContract as unknown as {
    instances: Array<{
      puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      state: StateV3 | null;
    }>;
    legacy: Map<string, Uint8Array>;
    activeState: StateV3 | null;
  };
  // Each test starts from a clean contract registry: the mocked class keeps
  // instances on the constructor for the whole file.
  fake.instances.length = 0;
  fake.legacy.clear();
  fake.legacy.set(
    V5_HASH,
    new TextEncoder().encode(options.legacy ?? legacyV5Json()),
  );
  fake.activeState = options.activeState ?? null;

  const sent: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const book: ContactRecord[] = (options.book ?? []).map((entry) => ({
    ...entry,
  }));
  let selfNameNextSeq = 1;
  let childNamesNextSeq = 1;
  let failingCalls = 0;

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
      onWarning: (message) => warnings.push(message),
    },
  );
  // The empty fixture parent would drive an address walk into the fake viewers;
  // this suite is about migration, not address derivation.
  vi.spyOn(board, "readBoard").mockResolvedValue(null);

  fakeTransport.handler = (request, callbacks) => {
    const payload = sentPayload([request as ClientRequestT]);
    sent.push(payload);
    const counters = {
      nextSeq: [1, 1, 1, 1, 1, 1, 1, 1],
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      adjustmentsNextSeq: 1,
      childNamesNextSeq,
      selfNameNextSeq,
    };
    let reply: object;
    if (payload.cmd === options.failOn) failingCalls += 1;
    if (payload.cmd === options.failOn && failingCalls === (options.failAt ?? 1)) {
      reply = { ok: false, error: "delegate storage is unavailable" };
    } else if (payload.cmd === "status") {
      reply = {
        ok: true,
        hasSeed: true,
        pubkey: OWNER,
        ...counters,
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
      reply = { ok: true, pubkey: OWNER, ...counters };
    } else if (payload.cmd === "contacts") {
      reply = { ok: true, contacts: book };
    } else if (payload.cmd === "contacts.add") {
      const entry: ContactRecord = {
        label: String(payload.label),
        userId: String(payload.userId),
        address: (payload.address as string | null) ?? null,
      };
      book.push(entry);
      reply = { ok: true, contacts: book };
    } else if (payload.cmd === "contacts.remove") {
      const index = book.findIndex((entry) => entry.userId === payload.userId);
      if (index !== -1) book.splice(index, 1);
      reply = { ok: true, contacts: book };
    } else if (payload.cmd === "signSelfName") {
      selfNameNextSeq = Number(payload.seq) + 1;
      reply = { ok: true, sig: SIG };
    } else if (payload.cmd === "signChildNames") {
      childNamesNextSeq = Number(payload.seq) + 1;
      reply = { ok: true, sig: SIG_B };
    } else {
      reply = { ok: true };
    }
    (callbacks.onDelegateResponse as
      | ((value: DelegateResponse) => void)
      | undefined)?.(response(reply));
  };

  return { board, sent, book, warnings };
}


/** Minimal in-memory localStorage; the migration marker lives here. */
function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
}

/** Let the post-start reconcile pass (one legacy probe, no network) finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * A v6 board that is ahead of every record in the v5 fixture, so the heal has
 * nothing to do: used by the address-book tests.
 */
function v6AheadState(): StateV3 {
  const state = emptyState();
  state.selfName = { seq: 1, name: "My board", sig: SIG };
  state.parent = { seq: 90, userId: PARENT, sig: SIG };
  state.payments = { seq: 90, settled: [], entry: null, sig: SIG };
  state.adjustments = { seq: 90, entries: [], sig: SIG };
  // Every slot ahead of the fixture, so only the address book is left to do.
  state.slots = state.slots.map((_, index) => ({
    seq: 90,
    entry:
      index === 0
        ? { value: 1250n, contact: ALICE, unit: "kg", note: "rent" }
        : null,
    sig: SIG,
  }));
  return state;
}

/** The state the migration produced, from the first harness in a test. */
async function migratedState(): Promise<StateV3> {
  const { board } = await harness();
  await board.start();
  await settle();
  const { NumberContract } = await import("./freenet");
  const fake = NumberContract as unknown as {
    instances: Array<{
      puts: Array<{ codeHash: string; state: StateV3; json: string }>;
    }>;
  };
  const put = fake.instances[0].puts[0];
  board.close();
  expect(put).toBeDefined();
  return put.state;
}

describe("OnlineBoard v5→v6 migration", () => {
  beforeEach(() => {
    fakeTransport.handler = null;
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("migrates the board, the address book and the names, and PUTs v6", async () => {
    const { board, sent, book, warnings } = await harness();
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await board.start();

    const legacy = JSON.parse(legacyV5Json());
    const contract = fake.instances[0];
    expect(contract.puts).toHaveLength(1);
    const put = contract.puts[0];
    expect(put.codeHash).toBe(ACTIVE);
    expect(put.state.v).toBe(6);
    expect(Object.keys(put.state)).not.toContain("contacts");
    expect(put.json).not.toContain('"contacts"');

    // Surviving records are unchanged: same seq, same signature, same values.
    expect(put.state.parent).toEqual({
      seq: legacy.parent.seq,
      userId: legacy.parent.userId,
      sig: legacy.parent.sig,
    });
    expect(put.state.payments.seq).toBe(legacy.payments.seq);
    expect(put.state.payments.sig).toBe(legacy.payments.sig);
    expect(put.state.payments.settled).toEqual(legacy.payments.settled);
    expect(put.state.payments.entry).toMatchObject({
      id: legacy.payments.entry.id,
      src: legacy.payments.entry.src,
      dst: legacy.payments.entry.dst,
      amount: 500n,
      phase: "forward",
      status: "offered",
    });
    expect(put.state.adjustments.seq).toBe(legacy.adjustments.seq);
    expect(put.state.adjustments.sig).toBe(legacy.adjustments.sig);
    expect(put.state.adjustments.entries).toEqual([
      {
        slot: 0,
        slotSeq: 3,
        delta: 250n,
        postValue: 1250n,
        note: "issue",
      },
    ]);
    expect(put.state.slots.map((slot) => [slot.seq, slot.sig])).toEqual(
      legacy.slots.map((slot: { seq: number; sig: string | null }) => [
        slot.seq,
        slot.sig,
      ]),
    );
    expect(put.state.slots[0].entry?.value).toBe(1250n);
    expect(put.state.slots[1].entry).toBeNull();

    // Only childNames migrate now: selfName is dormant and never seeded.
    expect(put.state.selfName).toEqual({ seq: 0, name: null, sig: null });
    expect(put.state.childNames).toEqual({
      seq: 1,
      entries: [
        { slot: 0, userId: ALICE, name: "Alice" },
        { slot: 3, userId: BOB, name: "Bob" },
      ],
      sig: SIG_B,
    });
    expect(sent.some((payload) => payload.cmd === "signSelfName")).toBe(false);
    expect(
      sent.find((payload) => payload.cmd === "signChildNames"),
    ).toEqual({
      cmd: "signChildNames",
      seq: 1,
      entries: [
        { slot: 0, userId: ALICE, name: "Alice" },
        { slot: 3, userId: BOB, name: "Bob" },
      ],
    });

    // The address book moved into the delegate, unsaved (address null). The
    // owner's own entry is not imported as a contact.
    expect(book).toEqual([
      { label: "Alice", userId: ALICE, address: null },
      { label: "Bob", userId: BOB, address: null },
    ]);
    expect(book.some((entry) => entry.userId === OWNER)).toBe(false);
    expect(board.contacts).toEqual(book);
    expect(warnings).toEqual([]);

    // The rendered zone is the migrated one: child names resolve immediately.
    expect(board.currentState?.selfName.name).toBeNull();
    expect(board.currentState?.childNames.entries.map((entry) => entry.name)).toEqual([
      "Alice",
      "Bob",
    ]);

    board.close();
  });

  it("leaves the book alone when the delegate already has one", async () => {
    const existing = { label: "Existing", userId: "77".repeat(32), address: "4" };
    const { board, sent, book } = await harness({ book: [existing] });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await board.start();

    // The board still migrates — the old book is readable — but nothing is
    // written into a book the user may have edited since.
    expect(fake.instances[0].puts).toHaveLength(1);
    expect(sent.some((payload) => payload.cmd === "contacts.add")).toBe(false);
    expect(book).toEqual([existing]);
    // Child names come from the old zones, not from the delegate book.
    const put = fake.instances[0].puts[0].state;
    expect(put.selfName.name).toBeNull();
    expect(put.childNames.entries).toHaveLength(2);
    // An existing book's labels win on the display path: the board shows what
    // the delegate holds.
    expect(board.contacts).toEqual([existing]);

    board.close();
  });


  it("rolls a partial import back so the retry can finish it", async () => {
    const { board, book } = await harness({ failOn: "contacts.add", failAt: 2 });

    await expect(board.start()).rejects.toThrow(
      /Could not migrate the previous zone/,
    );
    // One entry was accepted before the failure; it is undone so the empty-book
    // guard does not strand the remaining entries on the retry.
    expect(book).toEqual([]);

    await board.retry();

    expect(book.map((entry) => entry.label)).toEqual(["Alice", "Bob"]);
    expect(board.currentState?.childNames.entries).toHaveLength(2);

    board.close();
  });

  it("leaves selfName empty even when the old zone was named", async () => {
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      legacy: Map<string, Uint8Array>;
    };
    const legacy = JSON.parse(legacyV5Json());
    // No entry whose userId is the owner: the legacy book had no self-entry.
    legacy.contacts.entries = legacy.contacts.entries.filter(
      (entry: { userId: string }) => entry.userId !== OWNER,
    );
    const { board, sent } = await harness();
    fake.legacy.set(
      V5_HASH,
      new TextEncoder().encode(JSON.stringify(legacy)),
    );

    await board.start();

    expect(board.currentState?.selfName).toEqual({
      seq: 0,
      name: null,
      sig: null,
    });
    expect(sent.some((payload) => payload.cmd === "signSelfName")).toBe(false);
    // childNames still migrate: they come from the slots, not the self-entry.
    expect(board.currentState?.childNames.entries).toHaveLength(2);

    board.close();
  });

  it("does not PUT when the delegate write fails, and keeps the legacy board", async () => {
    const { board, warnings } = await harness({ failOn: "contacts.add" });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
      legacy: Map<string, Uint8Array>;
    };

    await expect(board.start()).rejects.toThrow(/Could not migrate the previous zone/);

    expect(fake.instances[0].puts).toHaveLength(0);
    // The only copy of the board is still the v5 instance, readable as before.
    expect(
      new TextDecoder().decode(fake.legacy.get(V5_HASH) ?? new Uint8Array()),
    ).toBe(legacyV5Json());
    expect(board.currentState).toBeNull();
    expect(warnings.join(" ")).toMatch(/delegate storage is unavailable/);
    expect(warnings.join(" ")).toMatch(/old zone is untouched/);

    board.close();
  });

  it("does not PUT when the name signing fails", async () => {
    const { board, warnings } = await harness({ failOn: "signChildNames" });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await expect(board.start()).rejects.toThrow(
      /Could not migrate the previous zone/,
    );
    expect(fake.instances[0].puts).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/delegate storage is unavailable/);

    board.close();
  });

  it("recovers the address book when a v6 board exists and the book is empty", async () => {
    const { board, book } = await harness({ activeState: v6AheadState() });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await board.start();
    await vi.waitFor(() => {
      expect(book).toHaveLength(2);
    });

    // Records were already converged: the repair is contacts only, no PUT.
    expect(fake.instances[0].puts).toHaveLength(0);
    expect(book.map((entry) => entry.label)).toEqual(["Alice", "Bob"]);
    expect(board.contacts).toEqual(book);
    // The once-only marker is recorded for this owner.
    expect(localStorage.getItem(contactsImportMarkerKey(OWNER))).toBe("1");

    board.close();
  });

  it("imports the book once: a deleted contact stays deleted across a reload", async () => {
    const active = v6AheadState();
    const first = await harness({ activeState: active });
    await first.board.start();
    await vi.waitFor(() => expect(first.book).toHaveLength(2));
    expect(localStorage.getItem(contactsImportMarkerKey(OWNER))).toBe("1");

    // The user deletes every imported contact (including the last one).
    for (const entry of [...first.book]) {
      await first.board.removeContact(entry.userId);
    }
    expect(first.book).toEqual([]);
    first.board.close();

    // Simulated reload: same browser (marker survives), same board, empty book.
    const second = await harness({ activeState: active });
    await second.board.start();
    await settle();

    expect(second.sent.some((payload) => payload.cmd === "contacts.add")).toBe(
      false,
    );
    expect(second.book).toEqual([]);
    expect(second.board.contacts).toEqual([]);

    second.board.close();
  });

  it("skips the automatic import when local storage is blocked", async () => {
    // No readable marker and no way to record one: an automatic import could
    // be replayed after the user clears the book, so it must not run.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage is blocked");
      },
      setItem: () => {
        throw new Error("storage is blocked");
      },
    });
    const { board, sent, book, warnings } = await harness({
      activeState: v6AheadState(),
    });

    await board.start();
    await settle();

    expect(sent.some((payload) => payload.cmd === "contacts.add")).toBe(false);
    expect(book).toEqual([]);
    expect(warnings.join(" ")).toMatch(/blocks local storage/);

    board.close();
  });

  it("does not import when the address book could not be read", async () => {
    const { board, sent, book, warnings } = await harness({
      activeState: v6AheadState(),
      failOn: "contacts",
    });

    await board.start();
    await settle();

    expect(sent.some((payload) => payload.cmd === "contacts.add")).toBe(false);
    expect(book).toEqual([]);
    // The failure is surfaced, and it is never treated as an empty book.
    expect(warnings.join(" ")).toMatch(/Could not read the private address book/);

    board.close();
  });

  it("heals an untouched legacy instance that is ahead, in one PUT", async () => {
    const migrated = await migratedState();

    // A stale bundle kept writing the v5 instance after the migration.
    const ahead = JSON.parse(legacyV5Json());
    ahead.slots[0] = {
      seq: 9,
      entry: { value: 9999, contact: ALICE, unit: "kg", note: "stale" },
      sig: SIG_C,
    };
    const { board, warnings } = await harness({
      activeState: migrated,
      legacy: JSON.stringify(ahead),
    });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await board.start();
    await vi.waitFor(() => {
      expect(fake.instances[0].puts).toHaveLength(1);
    });

    const healed = fake.instances[0].puts[0].state;
    expect(healed.v).toBe(6);
    expect(healed).not.toHaveProperty("contacts");
    // The newer legacy record wins the contract merge.
    expect(healed.slots[0].seq).toBe(9);
    expect(healed.slots[0].entry?.value).toBe(9999n);
    expect(healed.slots[0].entry?.note).toBe("stale");
    // Already-migrated records are untouched by the merge.
    expect(healed.parent.seq).toBe(2);
    expect(healed.payments.seq).toBe(4);
    expect(healed.adjustments.seq).toBe(3);
    // selfName stays dormant: the migrated state never seeds it.
    expect(board.currentState?.selfName).toEqual({
      seq: 0,
      name: null,
      sig: null,
    });
    expect(warnings.join(" ")).toMatch(/slot 0 \(seq 3 to 9\)/);

    board.close();
  });

  it("does not PUT when the two generations have already converged", async () => {
    const migrated = await migratedState();
    const { board, warnings } = await harness({ activeState: migrated });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await board.start();
    await settle();

    expect(fake.instances[0].puts).toHaveLength(0);
    expect(warnings).toEqual([]);

    board.close();
  });

  it("migrates the legacy records into an existing empty v6 instance", async () => {
    const { board, book } = await harness({ activeState: emptyState() });
    const { NumberContract } = await import("./freenet");
    const fake = NumberContract as unknown as {
      instances: Array<{
        puts: Array<{ codeHash: string; state: StateV3; json: string }>;
      }>;
    };

    await board.start();
    await vi.waitFor(() => {
      expect(fake.instances[0].puts).toHaveLength(1);
    });

    const migrated = fake.instances[0].puts[0].state;
    expect(migrated.v).toBe(6);
    expect(migrated).not.toHaveProperty("contacts");
    expect(migrated.slots[0].seq).toBe(3);
    expect(migrated.slots[1].seq).toBe(2);
    expect(migrated.parent.seq).toBe(2);
    expect(migrated.payments.seq).toBe(4);
    expect(migrated.adjustments.seq).toBe(3);
    // An empty zone has no child names to protect, so the old labels are seeded.
    expect(migrated.selfName.name).toBeNull();
    expect(migrated.childNames.entries).toEqual([
      { slot: 0, userId: ALICE, name: "Alice" },
      { slot: 3, userId: BOB, name: "Bob" },
    ]);
    expect(board.currentState?.slots[0].entry?.value).toBe(1250n);
    // The address book follows on the same pass.
    await vi.waitFor(() => expect(book).toHaveLength(2));
    expect(book.some((entry) => entry.userId === OWNER)).toBe(false);

    board.close();
  });

  it("does not touch a non-empty book during the repair pass", async () => {
    const existing = { label: "Mine", userId: ALICE, address: "12" };
    const { board, sent, book } = await harness({
      activeState: v6AheadState(),
      book: [existing],
    });

    await board.start();
    await settle();

    expect(sent.some((payload) => payload.cmd === "contacts.add")).toBe(false);
    expect(book).toEqual([existing]);

    board.close();
  });
});
