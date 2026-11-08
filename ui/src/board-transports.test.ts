/**
 * The board backends expose both standalone transports. The candidate transport
 * is lazy and must be closed with the board even when it never opened a socket.
 */
import { describe, expect, it, vi } from "vitest";
import { OnlineBoard } from "./board";
import { OfflineBoard } from "./mock";

const CONFIG = {
  contractCodeHash: "BLbDu5FZUdSfLrGejhuaWw5iMJBo3j3TVRyPv9rfJyMA",
  contractWasmUrl: "/number_contract.wasm",
  delegateWasmUrl: "/number_delegate.wasm",
  delegateKeyBytes: Array.from({ length: 32 }, () => 1),
  delegateCodeHashBytes: Array.from({ length: 32 }, () => 2),
  delegateParamsBytes: Array.from({ length: 32 }, () => 3),
};

const OWNER = "aa".repeat(32);

// A pending connection keeps `watchBoard`'s background setup from racing the
// assertions; the fake lets the test observe the viewer the cleanup closes.
const { FakeNumberContract } = vi.hoisted(() => {
  class FakeNumberContract {
    static readonly instances: FakeNumberContract[] = [];
    closed = 0;

    constructor() {
      FakeNumberContract.instances.push(this);
    }

    connect(): Promise<void> {
      return new Promise<void>(() => {
        // Never resolves: the watch setup stays pending until cleanup.
      });
    }

    readState(): Promise<never> {
      return new Promise<never>(() => {});
    }

    subscribe(): Promise<never> {
      return new Promise<never>(() => {});
    }

    close(): void {
      this.closed += 1;
    }
  }
  return { FakeNumberContract };
});

vi.mock("./freenet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./freenet")>();
  return { ...actual, NumberContract: FakeNumberContract };
});

function callbacks() {
  return {
    onStatus: vi.fn(),
    onState: vi.fn(),
    onIdentity: vi.fn(),
    onContractKey: vi.fn(),
    onError: vi.fn(),
  };
}

describe("board transports", () => {
  it("keeps the OnlineBoard candidate transport lazy and closes it", () => {
    const board = new OnlineBoard(CONFIG, callbacks());

    expect(board.roomTransport).toBe(board.roomTransport);
    expect(board.candidateTransport).toBe(board.candidateTransport);
    expect(typeof board.candidateTransport.read).toBe("function");

    const closeCandidate = vi.spyOn(board.candidateTransport, "close");
    board.close();
    expect(closeCandidate).toHaveBeenCalledTimes(1);
  });

  it("provides both in-memory transports on OfflineBoard", () => {
    const board = new OfflineBoard(callbacks());

    expect(board.roomTransport).toBeDefined();
    expect(board.candidateTransport).toBeDefined();
    expect(board.candidateTransport).toBe(board.candidateTransport);
    expect(typeof board.candidateTransport.request).toBe("function");
  });

  it("exposes watchBoard on both backends and cleans up idempotently", () => {
    const online = new OnlineBoard(CONFIG, callbacks());
    expect(typeof online.watchBoard).toBe("function");

    const before = FakeNumberContract.instances.length;
    const stop = online.watchBoard(OWNER, vi.fn());
    expect(typeof stop).toBe("function");
    expect(FakeNumberContract.instances.length).toBe(before + 1);

    const viewer = FakeNumberContract.instances[before];
    stop();
    expect(viewer.closed).toBe(1);
    // A second cleanup is a no-op, not a second close.
    stop();
    expect(viewer.closed).toBe(1);

    online.close();

    const offline = new OfflineBoard(callbacks());
    expect(typeof offline.watchBoard).toBe("function");
    const stopOffline = offline.watchBoard(OWNER, vi.fn());
    expect(typeof stopOffline).toBe("function");
    expect(() => stopOffline()).not.toThrow();
    expect(() => stopOffline()).not.toThrow();
  });
});
