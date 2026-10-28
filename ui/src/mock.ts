/**
 * In-memory backend for `VITE_OFFLINE_MODE=1`.
 *
 * It exercises the real UI, state codec, and merge rule without a Freenet node.
 * The store is deliberately memory-only: reloading the page starts fresh. The
 * signatures are deterministic mock bytes, not Ed25519 signatures, because
 * nothing verifies them in this mode.
 *
 * A small fixture tree is exposed so offline e2e can exercise the tree UI:
 * `MOCK_PARENT_ID` has a slot pointing at the own board and no parent, while
 * `MOCK_CHILD_ID` names the own board as its parent and has no slots.
 */

import { blake3 } from "@noble/hashes/blake3";
import { deriveInstanceIdFromBytes, encodeBase58 } from "./freenet";
import {
  emptyState,
  mergeDelta,
  validateContactList,
  validateEntry,
  type Contact,
  type Delta,
  type Entry,
  type StateV3,
} from "./state";
import { bytesToHex, delay, isLowerHex } from "./util";
import type { BoardBackend, BoardCallbacks, BoardSnapshot } from "./board";
import type { DelegateIdentity } from "./delegate";

const encoder = new TextEncoder();

/** `?unnamed=1` starts without a self-entry so e2e can exercise the prompt. */
function unnamedRequested(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("unnamed") === "1";
}

function digest(label: string): Uint8Array {
  return blake3(encoder.encode(label));
}

function mockSignature(slotIndex: number, seq: number, entry: Entry | null): string {
  // The entry value is a bigint now; keep the mock digest deterministic and
  // JSON-safe without depending on the real wire encoder.
  const body = JSON.stringify({
    slotIndex,
    seq,
    entry: entry && { ...entry, value: entry.value.toString() },
  });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:sig:0:${body}`), 0);
  bytes.set(digest(`number:offline:sig:1:${body}`), 32);
  return bytesToHex(bytes);
}

function mockContactsSignature(seq: number, entries: Contact[]): string {
  const body = JSON.stringify({
    seq,
    entries: entries.map((entry) => ({
      label: entry.label,
      userId: entry.userId,
    })),
  });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:contacts:0:${body}`), 0);
  bytes.set(digest(`number:offline:contacts:1:${body}`), 32);
  return bytesToHex(bytes);
}

function mockParentSignature(seq: number, userId: string | null): string {
  const body = JSON.stringify({ seq, userId });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:parent:0:${body}`), 0);
  bytes.set(digest(`number:offline:parent:1:${body}`), 32);
  return bytesToHex(bytes);
}

/**
 * Fixture owner ids for the offline tree. Both are stable across reloads so the
 * e2e suite can reference them, and neither is the own (mock) owner.
 */
export const MOCK_PARENT_ID = bytesToHex(
  digest("number:offline:v1:fixture-parent"),
);
export const MOCK_CHILD_ID = bytesToHex(
  digest("number:offline:v1:fixture-child"),
);

export class OfflineBoard implements BoardBackend {
  readonly mode = "offline" as const;
  readonly identity: DelegateIdentity;
  readonly contractKeyBase58: string;
  currentState: StateV3 | null = null;

  private readonly codeHashBytes: Uint8Array;
  private readonly pubkeyBytes: Uint8Array;
  private readonly fixtures = new Map<string, StateV3>();
  private started = false;
  private mutating = false;

  constructor(private readonly callbacks: BoardCallbacks) {
    this.codeHashBytes = digest("number:offline:v1:contract");
    this.pubkeyBytes = digest("number:offline:v1:owner");
    this.identity = {
      pubkey: bytesToHex(this.pubkeyBytes),
      nextSeq: Array.from({ length: 8 }, () => 1),
      contactsNextSeq: 1,
      parentNextSeq: 1,
    };
    this.contractKeyBase58 = deriveInstanceIdFromBytes(
      this.codeHashBytes,
      this.pubkeyBytes,
    ).base58;
  }

  async start(): Promise<StateV3> {
    if (this.started && this.currentState) return this.currentState;

    this.callbacks.onStatus("connecting", "starting offline mock");
    await delay(120);

    this.currentState = emptyState();
    if (!unnamedRequested()) {
      // The board name is the owner's self-entry in the signed address book.
      const entries: Contact[] = [
        { label: "My board", userId: this.identity.pubkey },
      ];
      this.currentState.contacts = {
        seq: 1,
        entries,
        sig: mockContactsSignature(1, entries),
      };
      this.identity.contactsNextSeq = 2;
    }
    this.started = true;
    this.callbacks.onIdentity(this.snapshotIdentity());
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

  async saveContacts(entries: Contact[]): Promise<void> {
    const normalised = entries.map((entry) => ({
      label: entry.label.trim(),
      userId: entry.userId.trim().toLowerCase(),
    }));
    const validated = validateContactList(normalised);

    if (!this.started || !this.currentState) {
      throw new Error("Offline board is not ready yet");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    try {
      await delay(70);
      const seq = Math.max(
        this.currentState.contacts.seq + 1,
        this.identity.contactsNextSeq ?? 1,
      );
      const delta: Delta = {
        v: 3,
        parent: null,
        contacts: {
          seq,
          entries: validated,
          sig: mockContactsSignature(seq, validated),
        },
        slots: [],
      };

      this.currentState = mergeDelta(this.currentState, delta);
      this.identity.contactsNextSeq = seq + 1;
      this.callbacks.onIdentity(this.snapshotIdentity());
      this.callbacks.onState(this.currentState);
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Set (or clear) the mock parent link with a deterministic mock signature.
   * Self-parent is rejected here as well, matching the delegate/contract rule.
   */
  async saveParent(userId: string | null): Promise<void> {
    if (userId !== null) {
      if (!isLowerHex(userId, 64)) {
        throw new Error(
          "The parent must be a 64-character lowercase hex user id.",
        );
      }
      if (userId === this.identity.pubkey) {
        throw new Error("A board cannot be its own parent.");
      }
    }

    if (!this.started || !this.currentState) {
      throw new Error("Offline board is not ready yet");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    try {
      await delay(70);
      const seq = Math.max(
        this.currentState.parent.seq + 1,
        this.identity.parentNextSeq ?? 1,
      );
      const delta: Delta = {
        v: 3,
        parent: { seq, userId, sig: mockParentSignature(seq, userId) },
        contacts: null,
        slots: [],
      };

      this.currentState = mergeDelta(this.currentState, delta);
      this.identity.parentNextSeq = seq + 1;
      this.callbacks.onIdentity(this.snapshotIdentity());
      this.callbacks.onState(this.currentState);
    } finally {
      this.mutating = false;
    }
  }

  async readBoard(ownerId: string): Promise<BoardSnapshot | null> {
    if (!isLowerHex(ownerId, 64)) {
      throw new Error(
        `The board owner must be a 64-character lowercase hex user id, got ${JSON.stringify(ownerId)}`,
      );
    }

    if (ownerId === this.identity.pubkey) {
      if (!this.currentState) return null;
      return this.snapshot(ownerId, this.currentState);
    }

    const fixture = this.fixtureFor(ownerId);
    return fixture === null ? null : this.snapshot(ownerId, fixture);
  }

  async exportIdentity(): Promise<never> {
    throw new Error("Offline mode has no identity to export.");
  }

  async importIdentity(): Promise<never> {
    throw new Error("Offline mode cannot import an identity.");
  }

  async installDelegate(): Promise<never> {
    throw new Error("Offline mode cannot install a delegate.");
  }

  private snapshot(ownerId: string, state: StateV3): BoardSnapshot {
    return {
      ownerId,
      state,
      codeHash: encodeBase58(this.codeHashBytes),
      legacy: false,
    };
  }

  private snapshotIdentity(): DelegateIdentity {
    return {
      pubkey: this.identity.pubkey,
      nextSeq: [...this.identity.nextSeq],
      contactsNextSeq: this.identity.contactsNextSeq,
      parentNextSeq: this.identity.parentNextSeq,
    };
  }

  /**
   * Fixed offline fixture boards so the tree UI has something to navigate:
   *  - parent: one slot whose contact is the own owner, no parent;
   *  - child: `parent.userId` is the own owner, no slots.
   */
  private fixtureFor(ownerId: string): StateV3 | null {
    if (ownerId !== MOCK_PARENT_ID && ownerId !== MOCK_CHILD_ID) return null;
    const cached = this.fixtures.get(ownerId);
    if (cached) return cached;

    const own = this.identity.pubkey;
    const fixture = emptyState();
    const selfName = ownerId === MOCK_CHILD_ID ? "Child board" : "Parent board";
    const selfEntries: Contact[] = [{ label: selfName, userId: ownerId }];
    fixture.contacts = {
      seq: 1,
      entries: selfEntries,
      sig: mockContactsSignature(1, selfEntries),
    };
    if (ownerId === MOCK_CHILD_ID) {
      fixture.parent = {
        seq: 1,
        userId: own,
        sig: mockParentSignature(1, own),
      };
    } else {
      const entry: Entry = {
        value: 850n,
        contact: own,
        unit: "kg",
        note: "Held by the parent board",
      };
      fixture.slots[0] = {
        seq: 1,
        entry,
        sig: mockSignature(0, 1, entry),
      };
    }

    this.fixtures.set(ownerId, fixture);
    return fixture;
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
        v: 3,
        parent: null,
        contacts: null,
        slots: [{ i: slotIndex, seq, entry, sig }],
      };

      this.currentState = mergeDelta(this.currentState, delta);
      this.identity.nextSeq[slotIndex] = seq + 1;
      this.callbacks.onIdentity(this.snapshotIdentity());
      this.callbacks.onState(this.currentState);
    } finally {
      this.mutating = false;
    }
  }

  async retry(): Promise<StateV3> {
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
