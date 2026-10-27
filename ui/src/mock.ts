/**
 * In-memory backend for `VITE_OFFLINE_MODE=1`.
 *
 * It exercises the real UI, state codec, and merge rule without a Freenet node.
 * The store is deliberately memory-only: reloading the page starts fresh. The
 * signatures are deterministic mock bytes, not Ed25519 signatures, because
 * nothing verifies them in this mode.
 */

import { blake3 } from "@noble/hashes/blake3";
import { deriveInstanceIdFromBytes, encodeBase58 } from "./freenet";
import {
  emptyState,
  mergeDelta,
  validateEntry,
  type Delta,
  type Entry,
  type StateV1,
} from "./state";
import { bytesToHex, delay } from "./util";
import type { BoardBackend, BoardCallbacks } from "./board";
import type { DelegateIdentity } from "./delegate";

const encoder = new TextEncoder();

function digest(label: string): Uint8Array {
  return blake3(encoder.encode(label));
}

function mockSignature(slotIndex: number, seq: number, entry: Entry | null): string {
  const body = JSON.stringify({ slotIndex, seq, entry });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:sig:0:${body}`), 0);
  bytes.set(digest(`number:offline:sig:1:${body}`), 32);
  return bytesToHex(bytes);
}

export class OfflineBoard implements BoardBackend {
  readonly mode = "offline" as const;
  readonly identity: DelegateIdentity;
  readonly contractKeyBase58: string;
  currentState: StateV1 | null = null;

  private readonly codeHashBytes: Uint8Array;
  private readonly pubkeyBytes: Uint8Array;
  private started = false;
  private mutating = false;

  constructor(private readonly callbacks: BoardCallbacks) {
    this.codeHashBytes = digest("number:offline:v1:contract");
    this.pubkeyBytes = digest("number:offline:v1:owner");
    this.identity = {
      pubkey: bytesToHex(this.pubkeyBytes),
      nextSeq: Array.from({ length: 8 }, () => 1),
    };
    this.contractKeyBase58 = deriveInstanceIdFromBytes(
      this.codeHashBytes,
      this.pubkeyBytes,
    ).base58;
  }

  async start(): Promise<StateV1> {
    if (this.started && this.currentState) return this.currentState;

    this.callbacks.onStatus("connecting", "starting offline mock");
    await delay(120);

    this.currentState = emptyState();
    this.started = true;
    this.callbacks.onIdentity(this.identity);
    this.callbacks.onContractKey(this.contractKeyBase58);
    this.callbacks.onState(this.currentState);
    this.callbacks.onStatus("offline", "in-memory mock; changes reset on reload");
    return this.currentState;
  }

  async save(slotIndex: number, entry: Entry): Promise<void> {
    await this.write(slotIndex, validateEntry(entry));
  }

  async clear(slotIndex: number): Promise<void> {
    await this.write(slotIndex, null);
  }

  private async write(slotIndex: number, entry: Entry | null): Promise<void> {
    if (!this.started || !this.currentState) {
      throw new Error("Offline board is not ready yet");
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 7) {
      throw new Error(`slot must be in 0..7, got ${slotIndex}`);
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    try {
      await delay(70);
      const nextSeq = this.identity.nextSeq[slotIndex] ?? 1;
      const seq = Math.max(this.currentState.slots[slotIndex].seq + 1, nextSeq);
      const sig = mockSignature(slotIndex, seq, entry);
      const delta: Delta = {
        v: 1,
        slots: [{ i: slotIndex, seq, entry, sig }],
      };

      this.currentState = mergeDelta(this.currentState, delta);
      this.identity.nextSeq[slotIndex] = seq + 1;
      this.callbacks.onIdentity({
        pubkey: this.identity.pubkey,
        nextSeq: [...this.identity.nextSeq],
      });
      this.callbacks.onState(this.currentState);
    } finally {
      this.mutating = false;
    }
  }

  async retry(): Promise<StateV1> {
    if (this.currentState) return this.currentState;
    return this.start();
  }

  close(): void {
    // Memory-only; keep the data so a manual "reconnect" in offline mode is a
    // no-op rather than data loss.
  }

  /** Exposed for debugging in the browser console during offline development. */
  get mockCodeHashBase58(): string {
    return encodeBase58(this.codeHashBytes);
  }
}
