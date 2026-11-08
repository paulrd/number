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
});
