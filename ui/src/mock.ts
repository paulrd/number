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
  I64_MAX,
  MAX_ADJUSTMENTS,
  emptyState,
  mergeDelta,
  optionalText,
  validateAdjustment,
  validateAdjustmentList,
  validateChildNameList,
  validateEntry,
  validatePaymentEntry,
  type Adjustment,
  type ChildName,
  type Delta,
  type DeltaSlot,
  type Entry,
  type StateV3,
} from "./state";
import { paymentId, type PaymentEntry } from "./payments";
import {
  contactListProblem,
  contactRecordProblem,
  normalizeContactList,
  normalizeContactRecord,
  type ContactRecord,
} from "./contact-rules";
import { bytesToHex, delay, isLowerHex } from "./util";
import {
  nextSettled,
  type BoardBackend,
  type BoardCallbacks,
  type BoardSnapshot,
  type PaymentSlotWrite,
} from "./board";
import { OfflineRoomTransport } from "./room-offline";
import { OfflineCandidateTransport } from "./candidate-offline";
import type { DelegateIdentity, DelegateStatus } from "./delegate";

const encoder = new TextEncoder();

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

function mockChildNamesSignature(seq: number, entries: ChildName[]): string {
  const body = JSON.stringify({
    seq,
    entries: entries.map((entry) => ({
      slot: entry.slot,
      userId: entry.userId,
      name: entry.name,
    })),
  });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:childnames:0:${body}`), 0);
  bytes.set(digest(`number:offline:childnames:1:${body}`), 32);
  return bytesToHex(bytes);
}

/** Validate one private address-book entry, mirroring the delegate bounds. */
function validateContactRecord(
  raw: unknown,
  path = "contact",
): ContactRecord {
  const problem = contactRecordProblem(raw, path);
  if (problem) throw new Error(problem);
  return normalizeContactRecord(raw);
}

function validateContactRecords(raw: unknown): ContactRecord[] {
  const problem = contactListProblem(raw, "contacts");
  if (problem) throw new Error(problem);
  return normalizeContactList(raw);
}

function mockParentSignature(seq: number, userId: string | null): string {
  const body = JSON.stringify({ seq, userId });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:parent:0:${body}`), 0);
  bytes.set(digest(`number:offline:parent:1:${body}`), 32);
  return bytesToHex(bytes);
}

function mockPaymentsSignature(
  seq: number,
  settled: string[],
  entry: PaymentEntry | null,
): string {
  // bigint fields cannot go through JSON.stringify directly; stringify them
  // explicitly so the mock digest stays deterministic.
  const body = JSON.stringify({
    seq,
    settled,
    entry:
      entry && {
        ...entry,
        amount: entry.amount.toString(),
        legs: entry.legs.map((leg) => ({
          ...leg,
          postValue: leg.postValue.toString(),
        })),
      },
  });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:payments:0:${body}`), 0);
  bytes.set(digest(`number:offline:payments:1:${body}`), 32);
  return bytesToHex(bytes);
}

function mockAdjustmentsSignature(seq: number, entries: Adjustment[]): string {
  const body = JSON.stringify({
    seq,
    entries: entries.map((entry) => ({
      slot: entry.slot,
      slotSeq: entry.slotSeq,
      delta: entry.delta.toString(),
      postValue: entry.postValue.toString(),
      note: entry.note,
    })),
  });
  const bytes = new Uint8Array(64);
  bytes.set(digest(`number:offline:adjustments:0:${body}`), 0);
  bytes.set(digest(`number:offline:adjustments:1:${body}`), 32);
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
/** A child of the own board that already carries an intent for the inbox. */
export const MOCK_PAYER_ID = bytesToHex(
  digest("number:offline:v1:fixture-payer"),
);
/** A sibling of the own board under MOCK_PARENT_ID, for source-side routing. */
export const MOCK_SIBLING_ID = bytesToHex(
  digest("number:offline:v1:fixture-sibling"),
);

export class OfflineBoard implements BoardBackend {
  readonly mode = "offline" as const;
  readonly identity: DelegateIdentity;
  readonly contractKeyBase58: string;
  readonly roomTransport: OfflineRoomTransport;
  readonly candidateTransport: OfflineCandidateTransport;
  currentState: StateV3 | null = null;
  /** A seeded delegate status, for offline tests of the background lane. */
  delegateStatus?: DelegateStatus;

  private readonly codeHashBytes: Uint8Array;
  private readonly pubkeyBytes: Uint8Array;
  private readonly fixtures = new Map<string, StateV3>();
  /** The private address book; delegate-owned, never part of contract state. */
  private addressBook: ContactRecord[] = [];
  private started = false;
  private mutating = false;

  get contacts(): ContactRecord[] {
    return this.addressBook.map((entry) => ({ ...entry }));
  }

  constructor(private readonly callbacks: BoardCallbacks) {
    this.codeHashBytes = digest("number:offline:v1:contract");
    this.pubkeyBytes = digest("number:offline:v1:owner");
    this.identity = {
      pubkey: bytesToHex(this.pubkeyBytes),
      nextSeq: Array.from({ length: 8 }, () => 1),
      contactsNextSeq: 1,
      parentNextSeq: 1,
      paymentsNextSeq: 1,
      adjustmentsNextSeq: 1,
      childNamesNextSeq: 1,
      selfNameNextSeq: 1,
    };
    this.contractKeyBase58 = deriveInstanceIdFromBytes(
      this.codeHashBytes,
      this.pubkeyBytes,
    ).base58;
    this.roomTransport = new OfflineRoomTransport(this.identity.pubkey);
    this.candidateTransport = new OfflineCandidateTransport(
      this.identity.pubkey,
    );
    // Offline e2e uses this to prove stored bodies are ciphertext, not text.
    (
      globalThis as {
        __TALLY_OFFLINE_ROOM_STATE__?: (ownerId: string) => unknown;
      }
    ).__TALLY_OFFLINE_ROOM_STATE__ = (ownerId: string) =>
      this.roomTransport.snapshot(ownerId);

    // `addInitScript` can seed a delegate fixture before the module loads.
    const seeded = (
      globalThis as { __TALLY_MOCK_DELEGATE__?: DelegateStatus }
    ).__TALLY_MOCK_DELEGATE__;
    if (seeded !== undefined) this.delegateStatus = seeded;
  }

  async start(): Promise<StateV3> {
    if (this.started && this.currentState) return this.currentState;

    this.callbacks.onStatus("connecting", "starting offline mock");
    await delay(120);

    this.currentState = emptyState();
    this.started = true;
    this.callbacks.onIdentity(this.snapshotIdentity());
    this.callbacks.onContractKey(this.contractKeyBase58);
    this.callbacks.onState(this.currentState);
    this.callbacks.onStatus("offline", "in-memory mock; changes reset on reload");
    return this.currentState;
  }

  async refreshDelegateStatus(): Promise<DelegateStatus | null> {
    return this.delegateStatus ?? null;
  }

  async setAutoAdvance(enabled: boolean, maxAmount: number): Promise<void> {
    if (this.delegateStatus === undefined) {
      throw new Error("The offline mock has no configured delegate.");
    }
    this.delegateStatus = { ...this.delegateStatus, autoAdvance: enabled, maxAmount };
    this.callbacks.onDelegateStatus?.(this.delegateStatus);
  }

  async save(slotIndex: number, entry: Entry): Promise<void> {
    await this.write(slotIndex, validateEntry(entry));
  }

  async clear(slotIndex: number): Promise<void> {
    await this.write(slotIndex, null);
  }

  /**
   * The delegate-side address book commands the v9 UI calls.
   */
  async listContacts(): Promise<ContactRecord[]> {
    return this.addressBook.map((entry) => ({ ...entry }));
  }

  async addContact(entry: {
    label: string;
    userId: string;
    address?: string | null;
  }): Promise<ContactRecord[]> {
    const record = validateContactRecord({
      label: entry.label,
      userId: entry.userId,
      address: entry.address ?? null,
    });
    return this.writeContacts([...this.addressBook, record]);
  }

  async updateContact(
    userId: string,
    patch: { label?: string; address?: string | null },
  ): Promise<ContactRecord[]> {
    const index = this.addressBook.findIndex((entry) => entry.userId === userId);
    if (index === -1) throw new Error(`no contact with userId ${userId}`);
    const current = this.addressBook[index];
    return this.writeContacts(
      this.addressBook.map((entry, at) =>
        at === index
          ? {
              label: patch.label ?? current.label,
              userId: current.userId,
              address:
                "address" in patch ? (patch.address ?? null) : current.address,
            }
          : entry,
      ),
    );
  }

  async removeContact(userId: string): Promise<ContactRecord[]> {
    const next = this.addressBook.filter((entry) => entry.userId !== userId);
    if (next.length === this.addressBook.length) {
      throw new Error(`no contact with userId ${userId}`);
    }
    return this.writeContacts(next);
  }

  private async writeContacts(
    entries: ContactRecord[],
  ): Promise<ContactRecord[]> {
    const validated = validateContactRecords(entries);
    this.addressBook = validated;
    if (this.started && this.currentState) {
      this.callbacks.onState(this.currentState);
    }
    return validated.map((entry) => ({ ...entry }));
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
        throw new Error("A zone cannot be its own parent.");
      }
    }

    if (!this.started || !this.currentState) {
      throw new Error("Offline zone is not ready yet");
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
        v: 6,
        parent: { seq, userId, sig: mockParentSignature(seq, userId) },
        selfName: null,
        childNames: null,
        payments: null,
        adjustments: null,
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

  /**
   * Sign a payments record and any slot writes as one in-memory delta, using
   * deterministic mock signatures. Mirrors `OnlineBoard.savePayment`: forward
   * intents (`legs: []`) gain one leg per slot write, while reversal records
   * keep their existing legs.
   */
  async savePayment(
    entry: PaymentEntry | null,
    slots: PaymentSlotWrite[],
  ): Promise<PaymentEntry | null> {
    if (!this.started || !this.currentState) {
      throw new Error("Offline zone is not ready yet");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    const validatedEntry = entry === null ? null : validatePaymentEntry(entry);
    const seen = new Set<number>();
    const writes = slots.map((write) => {
      if (
        !Number.isInteger(write.index) ||
        write.index < 0 ||
        write.index > 7
      ) {
        throw new Error(`slot must be in 0..7, got ${write.index}`);
      }
      if (seen.has(write.index)) {
        throw new Error(`duplicate slot index ${write.index}`);
      }
      seen.add(write.index);
      return { index: write.index, entry: validateEntry(write.entry) };
    });

    this.mutating = true;
    try {
      await delay(70);
      const paymentsSeq = Math.max(
        this.currentState.payments.seq + 1,
        this.identity.paymentsNextSeq ?? 1,
      );
      // Sign the slot writes first: their seq/sig/postValue become the payment
      // legs, and the payments signature must cover those completed legs.
      const nextSeq = [...this.identity.nextSeq];
      const deltaSlots: DeltaSlot[] = [];
      const newLegs: PaymentEntry["legs"] = [];
      for (const write of writes) {
        const seq = Math.max(
          this.currentState.slots[write.index].seq + 1,
          this.identity.nextSeq[write.index] ?? 1,
        );
        const sig = mockSignature(write.index, seq, write.entry);
        deltaSlots.push({
          i: write.index,
          seq,
          entry: write.entry,
          sig,
        });
        newLegs.push({ slot: write.index, seq, postValue: write.entry.value, sig });
        nextSeq[write.index] = seq + 1;
      }

      let signedEntry: PaymentEntry | null =
        validatedEntry === null
          ? null
          : {
              ...validatedEntry,
              legs:
                validatedEntry.legs.length === 0 && writes.length > 0
                  ? newLegs
                  : validatedEntry.legs.map((leg) => ({ ...leg })),
            };

      const sourceOrigin =
        signedEntry !== null &&
        signedEntry.src === this.identity.pubkey &&
        ((signedEntry.phase === "forward" &&
          (signedEntry.cursor === 0 || signedEntry.cursor === 1)) ||
          (signedEntry.phase === "terminal" &&
            signedEntry.status === "complete"));
      if (sourceOrigin && signedEntry !== null) {
        signedEntry = {
          ...signedEntry,
          id: paymentId(
            signedEntry.src,
            paymentsSeq,
            signedEntry.dst,
            signedEntry.amount,
          ),
        };
      }

      const settled = nextSettled(this.currentState.payments, signedEntry);

      const delta: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames: null,
        payments: {
          seq: paymentsSeq,
          settled,
          entry: signedEntry,
          sig: mockPaymentsSignature(paymentsSeq, settled, signedEntry),
        },
        adjustments: null,
        slots: deltaSlots,
      };

      this.currentState = mergeDelta(this.currentState, delta);
      this.identity.nextSeq = nextSeq;
      this.identity.paymentsNextSeq = paymentsSeq + 1;

      this.callbacks.onIdentity(this.snapshotIdentity());
      this.callbacks.onState(this.currentState);
      return signedEntry;
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Issue (positive delta) or burn (negative delta) one slot's liability with
   * deterministic mock signatures. Mirrors `OnlineBoard.issueOrBurn`: the slot
   * write and the capped v5 adjustment log travel in one delta, and the slot's
   * contact/unit/note are preserved. There is no real delegate in offline mode,
   * so the record gets a synthetic 128-hex signature the UI can render.
   */
  async issueOrBurn(
    slotIndex: number,
    delta: bigint,
    note: string,
  ): Promise<void> {
    if (!this.started || !this.currentState) {
      throw new Error("Offline zone is not ready yet");
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 7) {
      throw new Error(`slot must be in 0..7, got ${slotIndex}`);
    }
    if (typeof delta !== "bigint" || delta === 0n) {
      throw new Error("delta must be a non-zero bigint (hundredths).");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    const slot = this.currentState.slots[slotIndex];
    if (slot.entry === null) {
      throw new Error("Cannot issue or burn an empty slot.");
    }

    const newValue = slot.entry.value + delta;
    if (newValue < 0n) {
      throw new Error("A burn cannot take the slot below zero.");
    }
    if (newValue > I64_MAX) {
      throw new Error("The new value does not fit in a signed 64-bit integer.");
    }

    const slotSeq = Math.max(
      slot.seq + 1,
      this.identity.nextSeq[slotIndex] ?? 1,
    );
    const adjustment = validateAdjustment({
      slot: slotIndex,
      slotSeq,
      delta,
      postValue: newValue,
      note: optionalText(note),
    });
    const entries = [...this.currentState.adjustments.entries, adjustment];
    const capped =
      entries.length > MAX_ADJUSTMENTS
        ? entries.slice(entries.length - MAX_ADJUSTMENTS)
        : entries;
    validateAdjustmentList(capped);

    this.mutating = true;
    try {
      await delay(70);
      const entry: Entry = { ...slot.entry, value: newValue };
      const sig = mockSignature(slotIndex, slotSeq, entry);
      const adjustmentsSeq = Math.max(
        this.currentState.adjustments.seq + 1,
        this.identity.adjustmentsNextSeq ?? 1,
      );
      const deltaRecord: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames: null,
        payments: null,
        adjustments: {
          seq: adjustmentsSeq,
          entries: capped,
          sig: mockAdjustmentsSignature(adjustmentsSeq, capped),
        },
        slots: [{ i: slotIndex, seq: slotSeq, entry, sig }],
      };

      this.currentState = mergeDelta(this.currentState, deltaRecord);
      this.identity.nextSeq[slotIndex] = slotSeq + 1;
      this.identity.adjustmentsNextSeq = adjustmentsSeq + 1;

      this.callbacks.onIdentity(this.snapshotIdentity());
      this.callbacks.onState(this.currentState);
    } finally {
      this.mutating = false;
    }
  }

  async readBoard(ownerId: string): Promise<BoardSnapshot | null> {
    if (!isLowerHex(ownerId, 64)) {
      throw new Error(
        `The zone owner must be a 64-character lowercase hex user id, got ${JSON.stringify(ownerId)}`,
      );
    }

    if (ownerId === this.identity.pubkey) {
      if (!this.currentState) return null;
      return this.snapshot(ownerId, this.currentState);
    }

    const fixture = this.fixtureFor(ownerId);
    return fixture === null ? null : this.snapshot(ownerId, fixture);
  }

  /** Offline mode has no push transport; the watch is a no-op. */
  watchBoard(_ownerId: string, _onChange: () => void): () => void {
    return () => {
      // Nothing to stop.
    };
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
      contacts: ownerId === this.identity.pubkey ? this.contacts : [],
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
      paymentsNextSeq: this.identity.paymentsNextSeq ?? 1,
      adjustmentsNextSeq: this.identity.adjustmentsNextSeq ?? 1,
      childNamesNextSeq: this.identity.childNamesNextSeq ?? 1,
      selfNameNextSeq: this.identity.selfNameNextSeq ?? 1,
    };
  }

  /**
   * Fixed offline fixture boards so the tree UI has something to navigate:
   *  - parent: one slot whose contact is the own owner, no parent;
   *  - child: `parent.userId` is the own owner, no slots.
   */
  private fixtureFor(ownerId: string): StateV3 | null {
    const known = new Set([
      MOCK_PARENT_ID,
      MOCK_CHILD_ID,
      MOCK_PAYER_ID,
      MOCK_SIBLING_ID,
    ]);
    if (!known.has(ownerId)) return null;
    const cached = this.fixtures.get(ownerId);
    if (cached) return cached;

    const own = this.identity.pubkey;
    const fixture = emptyState();

    if (ownerId === MOCK_PARENT_ID) {
      const ownEntry: Entry = {
        value: 850n,
        contact: own,
        unit: "kg",
        note: "October allowance",
      };
      fixture.slots[0] = {
        seq: 1,
        entry: ownEntry,
        sig: mockSignature(0, 1, ownEntry),
      };
      const siblingEntry: Entry = {
        value: 200n,
        contact: MOCK_SIBLING_ID,
        unit: "kg",
        note: null,
      };
      fixture.slots[1] = {
        seq: 1,
        entry: siblingEntry,
        sig: mockSignature(1, 1, siblingEntry),
      };
      // A parent names each child by its own slot index (v6).
      const childNames = validateChildNameList([
        { slot: 0, userId: own, name: "My zone" },
        { slot: 1, userId: MOCK_SIBLING_ID, name: "Sibling zone" },
      ]);
      fixture.childNames = {
        seq: 1,
        entries: childNames,
        sig: mockChildNamesSignature(1, childNames),
      };
    } else if (ownerId === MOCK_SIBLING_ID) {
      fixture.parent = {
        seq: 1,
        userId: MOCK_PARENT_ID,
        sig: mockParentSignature(1, MOCK_PARENT_ID),
      };
    } else if (ownerId === MOCK_CHILD_ID || ownerId === MOCK_PAYER_ID) {
      fixture.parent = {
        seq: 1,
        userId: own,
        sig: mockParentSignature(1, own),
      };
    }

    if (ownerId === MOCK_PAYER_ID) {
      // The payer has already offered a payment through the own board (the LCA):
      // own slot 0 is the payer, own slot 1 is the child destination.
      const intent: PaymentEntry = {
        id: paymentId(MOCK_PAYER_ID, 1, MOCK_CHILD_ID, 250n),
        src: MOCK_PAYER_ID,
        dst: MOCK_CHILD_ID,
        amount: 250n,
        srcAddr: "0",
        dstAddr: "1",
        cursor: 0,
        phase: "forward",
        status: "offered",
        next: own,
        fail: null,
        legs: [],
      };
      fixture.payments = {
        seq: 1,
        settled: [],
        entry: intent,
        sig: mockPaymentsSignature(1, [], intent),
      };
    }

    this.fixtures.set(ownerId, fixture);
    return fixture;
  }

  private async write(slotIndex: number, entry: Entry | null): Promise<void> {
    if (!this.started || !this.currentState) {
      throw new Error("Offline zone is not ready yet");
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

      // Mirror the online write: saving a child slot also (re)writes the
      // parent's signed name for that slot; clearing removes it.
      const current = this.currentState.childNames;
      const existing = current.entries.find(
        (candidate) => candidate.slot === slotIndex,
      );
      const contact =
        entry === null
          ? null
          : (this.addressBook.find(
              (candidate) => candidate.userId === entry.contact,
            ) ?? null);
      const entries = current.entries.filter(
        (candidate) => candidate.slot !== slotIndex,
      );
      if (entry !== null) {
        if (contact !== null) {
          entries.push({
            slot: slotIndex,
            userId: entry.contact,
            name: contact.label,
          });
        } else if (existing !== undefined && existing.userId === entry.contact) {
          entries.push(existing);
        }
      }
      entries.sort((a, b) => a.slot - b.slot);
      const childEntries = validateChildNameList(entries);
      const childNames =
        JSON.stringify(childEntries) === JSON.stringify(current.entries)
          ? null
          : (() => {
              const childSeq = Math.max(
                current.seq + 1,
                this.identity.childNamesNextSeq ?? 1,
              );
              this.identity.childNamesNextSeq = childSeq + 1;
              return {
                seq: childSeq,
                entries: childEntries,
                sig: mockChildNamesSignature(childSeq, childEntries),
              };
            })();

      const delta: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames,
        payments: null,
        adjustments: null,
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
