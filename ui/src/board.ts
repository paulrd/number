/**
 * Orchestration: connect → delegate identity → derive key → GET/PUT/subscribe.
 * Sequence numbers follow DESIGN §8: take the larger of the contract's seq and
 * the delegate's nextSeq, then let the delegate sign and advance its counter.
 */

import bs58 from "bs58";
import {
  ContractBuildError,
  NumberContract,
  type ContractUpdate,
  type ConnectionStatus,
} from "./freenet";
import {
  LEGACY_CONTRACT_CODE_HASHES,
  LEGACY_DELEGATES,
} from "./migrations";
import {
  DEFAULT_MAX_AMOUNT,
  DelegateClient,
  DelegateError,
  type ContactRecord,
  type DelegateIdentity,
  type DelegateStatus,
  type ExportedSecrets,
} from "./delegate";
import { octalAddress } from "./tree-view";
import {
  I64_MAX,
  MAX_ADJUSTMENTS,
  MAX_PAYMENT_SETTLED,
  decodeDelta,
  decodeLegacyV5State,
  decodeState,
  emptyChildNames,
  emptySelfName,
  encodeState,
  entryFromInputs,
  mergeDelta,
  mergeStates,
  optionalText,
  validateAdjustment,
  validateAdjustmentList,
  validateChildNameList,
  validateEntry,
  validatePaymentEntry,
  type Adjustment,
  type ChildName,
  type ChildNames,
  type Delta,
  type DeltaSlot,
  type Entry,
  type StateV3,
  type StateV5,
} from "./state";
import { paymentId, type PaymentEntry, type PaymentsRecord } from "./payments";
import { OnlineRoomTransport, type RoomTransport } from "./room-client";
import {
  OnlineCandidateTransport,
  type CandidateTransport,
} from "./candidate-client";
import { errorMessage, hexToBytes, isLowerHex } from "./util";

export { entryFromInputs };

/**
 * Tree reads are best-effort. A missing instance can surface as a 12 s GET
 * timeout on this node, so a legacy generation gets a short probe. The current
 * generation must get the full GET budget: a slow first fetch of a real v3
 * board is not a reason to fall back to an old legacy board (that produced a
 * false "Pending" when the old board did not know the new child id).
 */
const CURRENT_BOARD_READ_TIMEOUT_MS = 12_000;
const LEGACY_BOARD_READ_TIMEOUT_MS = 4_000;

/**
 * Durable "this owner's v5 address book has already been imported" marker.
 *
 * The import must be a once-only event: the v5 instance is readable forever, so
 * a guard based only on the delegate book being empty would resurrect a contact
 * the user deleted (or the self-entry they removed) on every load. The marker
 * lives in this browser, scoped to the owner key, because the delegate has no
 * spare secret and adding one would re-key it.
 *
 * Key format: `number.v6.legacy-contacts-imported:<64-lowercase-hex-owner-id>`.
 */
export const CONTACTS_IMPORT_MARKER_PREFIX = "number.v6.legacy-contacts-imported";
const CONTACTS_IMPORT_MARKER_VALUE = "1";

export function contactsImportMarkerKey(ownerId: string): string {
  return `${CONTACTS_IMPORT_MARKER_PREFIX}:${ownerId}`;
}

type ImportMarkerState = "imported" | "absent" | "unavailable";

/**
 * Read the once-only marker. "unavailable" means storage is blocked or absent;
 * the automatic repair must then be skipped rather than risk resurrecting a
 * deleted book, because the import could not be remembered.
 */
function readContactsImportMarker(ownerId: string): ImportMarkerState {
  let storage: Storage | null;
  try {
    storage = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Access itself throws when the browser blocks storage for the origin.
    return "unavailable";
  }
  if (storage === null) return "unavailable";
  try {
    return storage.getItem(contactsImportMarkerKey(ownerId)) ===
      CONTACTS_IMPORT_MARKER_VALUE
      ? "imported"
      : "absent";
  } catch {
    return "unavailable";
  }
}

/** Record a completed import. False when the marker could not be stored. */
function writeContactsImportMarker(ownerId: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(
      contactsImportMarkerKey(ownerId),
      CONTACTS_IMPORT_MARKER_VALUE,
    );
    return true;
  } catch {
    return false;
  }
}

/** Canonical byte equality: `encodeState` validates and fixes key order. */
function sameState(a: StateV3, b: StateV3): boolean {
  const left = encodeState(a);
  const right = encodeState(b);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Surviving records where the legacy board is ahead of the v6 board, as
 * human-readable descriptions for the heal warning. `selfName`/`childNames` do
 * not exist on a v5 board, so they cannot be compared (or lost) here.
 */
function legacyAheadRecords(legacy: StateV5, current: StateV3): string[] {
  const ahead: string[] = [];
  if (legacy.parent.seq > current.parent.seq) {
    ahead.push(`parent (seq ${current.parent.seq} to ${legacy.parent.seq})`);
  }
  if (legacy.payments.seq > current.payments.seq) {
    ahead.push(
      `payments (seq ${current.payments.seq} to ${legacy.payments.seq})`,
    );
  }
  if (legacy.adjustments.seq > current.adjustments.seq) {
    ahead.push(
      `adjustments (seq ${current.adjustments.seq} to ${legacy.adjustments.seq})`,
    );
  }
  legacy.slots.forEach((slot, index) => {
    if (slot.seq > current.slots[index].seq) {
      ahead.push(`slot ${index} (seq ${current.slots[index].seq} to ${slot.seq})`);
    }
  });
  return ahead;
}

export type BoardStatus =
  | "starting"
  | "connecting"
  | "identity"
  | "ready"
  | "offline"
  | "disconnected"
  | "error";

export interface BoardCallbacks {
  onStatus: (status: BoardStatus, detail?: string) => void;
  onState: (state: StateV3) => void;
  onIdentity: (identity: DelegateIdentity) => void;
  onContractKey: (keyBase58: string) => void;
  onError: (error: Error) => void;
  onWarning?: (message: string) => void;
  /** Latest delegate auto-advance status; null before the delegate answers. */
  onDelegateStatus?: (status: DelegateStatus | null) => void;
  /**
   * Called when the node does not have the number-delegate installed. The UI
   * asks the user to install the bundled delegate and resolves after
   * `installDelegate()` succeeds. If it rejects, the board cannot continue.
   */
  onDelegateRequired?: () => Promise<void>;
  /**
   * Called once, before the first identity is created, when the delegate has
   * no seed and no legacy predecessor answered. The UI offers "create a new
   * identity" or "import a backup"; it resolves when the user has chosen or a
   * successful import has happened. The board then continues (and creates a
   * seed only if one still does not exist).
   */
  onIdentityRequired?: () => Promise<void>;
}

export interface BoardConfig {
  contractCodeHash: string;
  contractWasmUrl: string;
  /** Site-relative URL of the bundled delegate WASM, used for installation. */
  delegateWasmUrl: string;
  delegateKeyBytes: number[];
  delegateCodeHashBytes: number[];
  delegateParamsBytes: number[];
}

export interface BoardSnapshot {
  /** Owner pubkey of this board (64 lowercase hex). */
  ownerId: string;
  state: StateV3;
  /**
   * The private address book that labels slots in the editor. Only the owner's
   * own board carries one (the delegate owns it); every other board's list is
   * empty, because v6 removed public contacts from contract state.
   */
  contacts: ContactRecord[];
  /** Base58 code hash of the contract instance the state was read from. */
  codeHash: string;
  /** True when the state came from a superseded (v2) contract generation. */
  legacy: boolean;
}

/** One slot write bundled into a payment delta. */
export interface PaymentSlotWrite {
  index: number;
  entry: Entry;
}

/**
 * The next `settled` list for a board that is about to sign `entry`.
 *
 * When the outgoing entry is replaced by a different id (or cleared), its id is
 * appended unless it is already listed, and only the newest `MAX_PAYMENT_SETTLED`
 * ids are kept (oldest first, so the oldest drop off the front). Signing the
 * same id again leaves the list untouched.
 */
export function nextSettled(
  previous: PaymentsRecord,
  entry: PaymentEntry | null,
): string[] {
  const outgoing = previous.entry;
  const settled = [...previous.settled];
  if (outgoing !== null && (entry === null || entry.id !== outgoing.id)) {
    if (!settled.includes(outgoing.id)) settled.push(outgoing.id);
    return settled.slice(-MAX_PAYMENT_SETTLED);
  }
  return settled;
}

export interface BoardBackend {
  readonly mode: "online" | "offline";
  readonly identity: DelegateIdentity | null;
  readonly contractKeyBase58: string | null;
  /** Members-room transport; it opens its own connection only when used. */
  readonly roomTransport: RoomTransport;
  /** Candidate-room transport; it opens its own connection only when used. */
  readonly candidateTransport: CandidateTransport;
  readonly currentState: StateV3 | null;
  /** The owner's private address book, as last read from the delegate. */
  readonly contacts: ContactRecord[];
  /** Latest delegate auto-advance status (online backend only). */
  readonly delegateStatus?: DelegateStatus | null;
  start(): Promise<StateV3>;
  save(slotIndex: number, entry: Entry): Promise<void>;
  clear(slotIndex: number): Promise<void>;
  /** Read the private address book back from the delegate. */
  listContacts(): Promise<ContactRecord[]>;
  /** Add one address-book entry; the delegate rejects duplicates. */
  addContact(entry: {
    label: string;
    userId: string;
    address?: string | null;
  }): Promise<ContactRecord[]>;
  /** Change one entry's label and/or address; the address is preserved. */
  updateContact(
    userId: string,
    patch: { label?: string; address?: string | null },
  ): Promise<ContactRecord[]>;
  /** Remove one address-book entry by userId. */
  removeContact(userId: string): Promise<ContactRecord[]>;
  /** Set (or clear with null) this board's signed parent link. */
  saveParent(userId: string | null): Promise<void>;
  /**
   * Sign a payments record and any slot writes it performed, and send them as
   * one delta. A null entry is a tombstone at the new seq.
   */
  savePayment(
    entry: PaymentEntry | null,
    slots: PaymentSlotWrite[],
  ): Promise<PaymentEntry | null>;
  /**
   * Clear a stuck non-terminal payment on the owner's own board by signing a
   * payments tombstone at the next seq. Does not move value.
   */
  clearStuckPayment?(): Promise<void>;
  /**
   * Sign an issue (positive delta) or burn (negative delta) to one slot's
   * liability: an ordinary slot write plus one signed v5 adjustment record in a
   * single delta. Deltas are hundredths; burn clamps at 0. Optional for
   * backends that cannot sign v5 adjustments (offline).
   */
  issueOrBurn?(slotIndex: number, delta: bigint, note: string): Promise<void>;
  /** Read one board by owner id; null when no instance/state exists. */
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
  /** Subscribe to another owner's zone; returns cleanup. */
  watchBoard(ownerId: string, onChange: () => void): () => void;
  retry(): Promise<StateV3>;
  /** Export the owner seed and counters for a backup. */
  exportIdentity(): Promise<ExportedSecrets>;
  /** Restore a seed into a delegate that has none (a new device). */
  importIdentity(
    seed: string,
    nextSeq: number[],
    contactsNextSeq: number,
    parentNextSeq: number,
    paymentsNextSeq?: number,
    adjustmentsNextSeq?: number,
    childNamesNextSeq?: number,
    selfNameNextSeq?: number,
    payloadVersion?: number,
    contacts?: ContactRecord[],
  ): Promise<void>;
  /** Register the bundled delegate on this node (a fresh device). */
  installDelegate(): Promise<void>;
  /** Read the delegate's auto-advance status without changing anything. */
  refreshDelegateStatus?(): Promise<DelegateStatus | null>;
  /** Enable/disable delegate auto-advance and optionally change its cap. */
  setAutoAdvance?(enabled: boolean, maxAmount?: number): Promise<void>;
  close(): void;
}

export class OnlineBoard implements BoardBackend {
  readonly mode = "online" as const;

  identity: DelegateIdentity | null = null;
  contractKeyBase58: string | null = null;
  currentState: StateV3 | null = null;
  delegateStatus: DelegateStatus | null = null;
  /** The delegate's private address book, cached for synchronous renders. */
  contactsCache: ContactRecord[] = [];
  /**
   * True once the address book has been read successfully at least once. A read
   * failure is not an empty book: the migration and repair paths must not treat
   * "unreadable" as "nothing there".
   */
  private contactsReadable = false;
  private contactsReadWarningShown = false;
  private importMarkerWarningShown = false;

  get contacts(): ContactRecord[] {
    return this.contactsCache.map((entry) => ({ ...entry }));
  }

  /**
   * The members room uses its own WebSocket. Creating the transport is inert;
   * the connection is opened on the first read or write from the panel.
   */
  get roomTransport(): RoomTransport {
    if (this.roomTransportValue === null) {
      this.roomTransportValue = new OnlineRoomTransport(this.delegate);
    }
    return this.roomTransportValue;
  }

  /**
   * The candidate room uses its own WebSocket. Creating the transport is inert;
   * the connection is opened on the first read or write from the panel.
   */
  get candidateTransport(): CandidateTransport {
    if (this.candidateTransportValue === null) {
      this.candidateTransportValue = new OnlineCandidateTransport(this.delegate);
    }
    return this.candidateTransportValue;
  }

  private contract: NumberContract | null = null;
  private readonly delegate: DelegateClient;
  private roomTransportValue: OnlineRoomTransport | null = null;
  private candidateTransportValue: OnlineCandidateTransport | null = null;
  private readonly delegateClients: DelegateClient[] = [];
  /** Read-only viewers for other owners' boards, keyed by code hash. */
  private readonly viewers = new Map<string, NumberContract>();
  /** Dedicated subscription viewers, one per watchBoard call. */
  private readonly watchViewers = new Set<NumberContract>();
  private migrating = false;
  private started = false;
  private startPromise: Promise<StateV3> | null = null;
  private mutating = false;
  /** Coalesces configure calls triggered by state/parent changes. */
  private configuring: Promise<void> | null = null;
  private configurationDirty = false;

  constructor(
    private readonly config: BoardConfig,
    private readonly callbacks: BoardCallbacks,
  ) {
    this.delegate = new DelegateClient(
      (request) => {
        if (!this.contract) {
          throw new Error("Freenet connection is not open");
        }
        this.contract.sendClientRequest(request);
      },
      config.delegateKeyBytes,
      config.delegateCodeHashBytes,
      config.delegateParamsBytes,
    );
    this.delegateClients.push(this.delegate);
  }

  start(): Promise<StateV3> {
    if (this.started && this.currentState) return Promise.resolve(this.currentState);
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /**
   * Forward-only delegate secret recovery.
   *
   * A successor delegate starts with an empty secret store. If the committed
   * registry has predecessors, ask each one for its exported seed and import
   * the first answer before `identity()` creates a fresh seed. A predecessor
   * published before the export handler existed cannot answer; that generation
   * is unrecoverable and is recorded as such in `migrations.ts`.
   */
  /**
   * Make sure the node has this app's delegate before anything asks it for an
   * identity. A delegate is local to a node and is not fetched from the
   * network, so a fresh node has neither the code nor a seed.
   */
  private async ensureDelegate(): Promise<void> {
    const probe = await this.delegate
      .status(10_000)
      .then(() => null)
      .catch((error: unknown) => error);

    if (probe === null) return;
    // A missing delegate is not answered at all by the client API (the node
    // logs it and returns no application message), so the only signal a fresh
    // node gives is a timeout. Treat that as "may need installing": the
    // registration is idempotent, and a genuinely unresponsive node fails the
    // post-install probe with the same error.
    const needsInstall =
      probe instanceof DelegateError &&
      (probe.code === "Missing" || probe.code === "Timeout");
    if (!needsInstall) throw probe;
    if (!this.callbacks.onDelegateRequired) throw probe;

    this.callbacks.onStatus("identity", "installing the local delegate");
    await this.callbacks.onDelegateRequired();
    // The prompt resolves only after a successful install; re-probe so a
    // dismissed/failed prompt fails here with the delegate error, not later.
    await this.delegate.status(10_000);
  }

  private async migrateDelegateSecrets(): Promise<void> {
    if (LEGACY_DELEGATES.length === 0) return;

    const status = await this.delegate.status().catch(() => null);
    if (status?.hasSeed) return;

    const currentKey = bs58.encode(new Uint8Array(this.config.delegateKeyBytes));
    for (const legacy of LEGACY_DELEGATES) {
      if (legacy.key === currentKey) continue;
      try {
        const keyBytes = Array.from(bs58.decode(legacy.key));
        const codeHashBytes = Array.from(bs58.decode(legacy.codeHash));
        const paramsBytes = Array.from(bs58.decode(legacy.webappId));
        if (
          keyBytes.length !== 32 ||
          codeHashBytes.length !== 32 ||
          paramsBytes.length !== 32
        ) {
          throw new Error("legacy delegate registry entry is not 32 bytes");
        }

        const predecessor = new DelegateClient(
          (request) => {
            if (!this.contract) throw new Error("Freenet connection is not open");
            this.contract.sendClientRequest(request);
          },
          keyBytes,
          codeHashBytes,
          paramsBytes,
        );
        this.delegateClients.push(predecessor);
        try {
          const exported = await predecessor.exportSecrets();
          await this.delegate.importSecrets(
            exported.seed,
            exported.nextSeq,
            exported.contactsNextSeq,
            exported.parentNextSeq,
            exported.paymentsNextSeq ?? 1,
            exported.adjustmentsNextSeq ?? 1,
            exported.childNamesNextSeq ?? 1,
            exported.selfNameNextSeq ?? 1,
            exported.payloadVersion ?? 1,
            exported.contacts,
          );
          this.callbacks.onWarning?.(
            "Recovered the owner identity from the previous delegate.",
          );
          return;
        } finally {
          const index = this.delegateClients.indexOf(predecessor);
          if (index !== -1) this.delegateClients.splice(index, 1);
        }
      } catch (error) {
        console.warn(
          "[migration] delegate predecessor did not answer:",
          errorMessage(error),
        );
      }
    }
  }

  /**
   * Upgrade a probed legacy board to v6 (DESIGN-v6.md §6).
   *
   * The order is the point of this method:
   *   1. write the old address book into the delegate (once only),
   *   2. sign `selfName` from the old self-entry,
   *   3. sign `childNames` from the labels the parent already showed,
   *   4. return the v6 state for the caller to PUT.
   *
   * Every surviving record (`parent`, `slots`, `payments`, `adjustments`) is
   * copied unmodified: their signing bytes did not change, so re-signing would
   * only invalidate what the old board already proved. `contacts` is dropped,
   * never carried. The caller PUTs this only if every step above succeeded, so
   * a delegate failure leaves the legacy instance as the only copy.
   */
  private async upgradeLegacyBoard(
    raw: Uint8Array,
    codeHash: string,
  ): Promise<StateV3> {
    const identity = this.identity;
    if (!identity) {
      throw new Error("the owner identity is not available yet");
    }

    try {
      const legacy = decodeLegacyV5State(raw);
      // The first migration is the only chance to save the book, so it imports
      // even when the once-only marker cannot be recorded.
      await this.importLegacyContacts(legacy, identity, false);
      return await this.assembleMigratedState(legacy, identity, true);
    } catch (error) {
      const message =
        `Could not migrate the previous zone (${codeHash}): ${errorMessage(error)} ` +
        "Nothing was written, so the old zone is untouched. " +
        "Fix the cause and retry; the old zone stays readable until then.";
      this.callbacks.onWarning?.(message);
      throw new Error(message);
    }
  }

  /**
   * The v6 board a legacy v5 state implies: surviving records untouched, and
   * `childNames` signed from the old slot labels when `seedNames` is set.
   *
   * `selfName` has no role any more. It stays in the schema so an older board
   * still decodes and merges, but migration never writes or seeds it: only a
   * parent-given child name is shown anywhere now.
   *
   * The heal passes `seedNames: false` unless the v6 board has no child names
   * at all: signing again would replay the pre-migration label over a rename
   * the user made after migrating.
   */
  private async assembleMigratedState(
    legacy: StateV5,
    identity: DelegateIdentity,
    seedNames: boolean,
  ): Promise<StateV3> {
    const selfName = emptySelfName();
    const childNames = seedNames
      ? await this.seedChildNames(identity, legacy)
      : emptyChildNames();

    return {
      v: 6,
      selfName,
      parent: legacy.parent,
      childNames,
      payments: legacy.payments,
      adjustments: legacy.adjustments,
      slots: legacy.slots,
    };
  }

  /**
   * Copy a v5 address book into the delegate as unsaved entries (`address:
   * null`: a v5 contact was public signed data, not a payment route).
   *
   * This is a once-only event, guarded in this order:
   *   1. the durable per-owner marker must be absent — book emptiness alone
   *      would resurrect contacts the user has deleted, because the v5 instance
   *      stays readable forever;
   *   2. the delegate book must be readable and empty — the user's own entries
   *      are never overwritten;
   *   3. the old book must still have entries after dropping the owner's
   *      self-entry, which v6 keeps as `selfName` instead of a contact.
   *
   * The marker is written only after the whole import succeeds, so a retry
   * after a partial failure still runs. `automatic` marks the background repair
   * pass: it must not import when the marker cannot be recorded, because the
   * book could then be resurrected after the user clears it.
   */
  private async importLegacyContacts(
    legacy: StateV5,
    identity: DelegateIdentity,
    automatic: boolean,
  ): Promise<boolean> {
    const marker = readContactsImportMarker(identity.pubkey);
    if (marker === "imported") return false;
    if (marker === "unavailable") {
      if (automatic) {
        if (!this.importMarkerWarningShown) {
          this.importMarkerWarningShown = true;
          this.callbacks.onWarning?.(
            "This browser blocks local storage, so the address book was not " +
              "imported automatically: without a record of the import it could " +
              "come back after you clear it.",
          );
        }
        return false;
      }
      // The first migration still imports (it is the only chance to save the
      // book); `recordLegacyImport` reports that it could not be remembered.
    }

    // Read through, not from the cache: another tab may have written since.
    const existing = await this.delegate.listContacts();
    this.contactsCache = existing;
    this.contactsReadable = true;
    if (existing.length > 0) return false;

    // The owner's own entry was the address book's self-entry. v6 keeps it as
    // the signed `selfName` record, so importing it would create a phantom
    // contact that the delegate refuses to re-add once removed.
    const entries = legacy.contacts.entries.filter(
      (entry) => entry.userId !== identity.pubkey,
    );
    if (entries.length === 0) {
      // Nothing to import; still record that the legacy book is consumed so the
      // probe is not repeated on every start.
      this.recordLegacyImport(identity.pubkey);
      return false;
    }

    const imported: string[] = [];
    try {
      for (const entry of entries) {
        this.contactsCache = await this.delegate.addContact({
          label: entry.label,
          userId: entry.userId,
          address: null,
        });
        imported.push(entry.userId);
      }
    } catch (error) {
      // A partial book would satisfy the empty-book guard on the retry and
      // silently strand the remaining entries, so undo what this run added.
      await this.rollbackContacts(imported);
      throw error;
    }
    this.recordLegacyImport(identity.pubkey);
    return true;
  }

  /**
   * Write the once-only marker.
   *
   * The published app runs in a sandboxed, opaque-origin iframe, where
   * `localStorage` always throws, so the marker is normally unavailable. That
   * is expected, not a failure the user should see: without a marker the
   * automatic repair simply never runs, which is the safe direction (a deleted
   * contact is never resurrected). A real storage failure in a normal tab has
   * the same benign consequence, so this stays out of the notice area.
   */
  private recordLegacyImport(ownerId: string): void {
    if (writeContactsImportMarker(ownerId)) return;
    console.info(
      "[migration] address book imported; this environment cannot record it, " +
        "so the import will not be repeated automatically",
    );
  }

  /**
   * Best-effort undo of the entries one failed import added. Skipped when the
   * book holds anything this run did not add (a concurrent edit wins).
   */
  private async rollbackContacts(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      const current = await this.delegate.listContacts();
      const own = new Set(userIds);
      if (current.some((entry) => !own.has(entry.userId))) return;
      for (const userId of userIds) {
        this.contactsCache = await this.delegate.removeContact(userId);
      }
    } catch (error) {
      console.warn(
        "[migration] could not roll back a partial contact import:",
        errorMessage(error),
      );
    }
  }

  /**
   * `childNames` from what the parent already showed: for each slot holding a
   * contact, the label of that `userId` in the old address book. Slots with no
   * contact, or with a contact the old book no longer labels, are skipped.
   * Ascending slot order is guaranteed by iterating the slots in order.
   */
  private async seedChildNames(
    identity: DelegateIdentity,
    legacy: StateV5,
  ): Promise<ChildNames> {
    const labels = new Map(
      legacy.contacts.entries.map((entry) => [entry.userId, entry.label]),
    );
    const entries: ChildName[] = [];
    legacy.slots.forEach((slot, index) => {
      const contact = slot.entry?.contact ?? null;
      if (contact === null) return;
      const label = labels.get(contact);
      if (label === undefined || label.length === 0) return;
      entries.push({ slot: index, userId: contact, name: label });
    });
    if (entries.length === 0) return emptyChildNames();

    const validated = validateChildNameList(entries);
    const seq = Math.max(1, identity.childNamesNextSeq ?? 1);
    const sig = await this.delegate.signChildNames(seq, validated);
    this.identity = {
      ...(this.identity ?? identity),
      childNamesNextSeq: seq + 1,
    };
    return { seq, entries: validated, sig };
  }

  /**
   * Reconcile this board with an untouched legacy instance. Runs after
   * configure and never blocks the first render.
   *
   * Two independent repairs share one legacy probe:
   *   - records: a stale bundle (or the pre-v9 delegate auto-advancing legs)
   *     can keep writing the v5 instance after this board migrated, so heal any
   *     record where the legacy board is ahead;
   *   - contacts: the once-only import of the old address book.
   */
  private async reconcileLegacyGeneration(): Promise<void> {
    const identity = this.identity;
    if (!identity || !this.started || !this.contract) return;
    const legacy = await this.readLegacyBoard(identity.pubkey);
    if (legacy === null) return;
    await this.healLegacyAheadRecords(legacy, identity);
    await this.repairLegacyContacts(legacy, identity);
  }

  /**
   * Heal a fork: the v5 instance stayed writable after migration, so a stale
   * bundle can have written records there that never merge back on their own.
   * When any surviving record is ahead, build its v6 form and merge it into the
   * current state. Same owner signed both sides, so this is the contract's own
   * whole-record merge: idempotent, and a no-op once the sides have converged.
   */
  private async healLegacyAheadRecords(
    legacy: StateV5,
    identity: DelegateIdentity,
  ): Promise<void> {
    const contract = this.contract;
    const current = this.currentState;
    if (!contract || !current || this.mutating) return;

    const ahead = legacyAheadRecords(legacy, current);
    if (ahead.length === 0) return;

    // An empty v6 instance never received the legacy records (the known gap):
    // seed its child names too. A zone that already has child names keeps them.
    const seedNames = current.childNames.seq === 0;

    let merged: StateV3;
    try {
      merged = mergeStates(
        current,
        await this.assembleMigratedState(legacy, identity, seedNames),
      );
    } catch (error) {
      if (!seedNames) {
        this.callbacks.onWarning?.(
          "Could not reconcile records from the previous version of this zone: " +
            errorMessage(error),
        );
        return;
      }
      // Names are cosmetic; the surviving records are not. Do not leave the
      // fork unhealed over a name that could not be signed.
      try {
        merged = mergeStates(
          current,
          await this.assembleMigratedState(legacy, identity, false),
        );
      } catch (fallbackError) {
        this.callbacks.onWarning?.(
          "Could not reconcile records from the previous version of this zone: " +
            errorMessage(fallbackError),
        );
        return;
      }
    }
    if (sameState(merged, current)) return;

    try {
      await contract.publishState(hexToBytes(identity.pubkey), merged);
    } catch (error) {
      this.callbacks.onWarning?.(
        `Could not recover newer records from the previous version of this zone: ${errorMessage(error)}`,
      );
      return;
    }

    this.callbacks.onWarning?.(
      `Recovered newer records from the previous version of this zone: ${ahead.join(", ")}.`,
    );
    try {
      const fresh = await contract.getState();
      this.currentState = fresh;
      this.callbacks.onState(fresh);
    } catch (error) {
      this.currentState = merged;
      this.callbacks.onState(merged);
      this.callbacks.onWarning?.(
        `Recovered the records, but could not refresh the zone: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Once-only address-book repair: a v6 board exists but this browser never
   * imported the old book. Guarded by the marker, then by readability, then by
   * the book being empty, so deleted contacts stay deleted.
   */
  private async repairLegacyContacts(
    legacy: StateV5,
    identity: DelegateIdentity,
  ): Promise<void> {
    if (readContactsImportMarker(identity.pubkey) === "imported") return;
    // "Could not read" is not "empty": never import over an unknown book.
    if (!this.contactsReadable) return;
    if (this.contactsCache.length > 0) return;

    try {
      if (await this.importLegacyContacts(legacy, identity, true)) {
        this.repaintAfterContactsChange();
        this.callbacks.onWarning?.(
          "Recovered the private address book from the previous version of this zone.",
        );
      }
    } catch (error) {
      this.callbacks.onWarning?.(
        `Could not recover the address book from the previous version of this zone: ${errorMessage(error)}`,
      );
    }
  }

  /** Probe the migratable legacy instances for this owner's old board. */
  private async readLegacyBoard(ownerId: string): Promise<StateV5 | null> {
    const parameters = hexToBytes(ownerId);
    for (const codeHash of LEGACY_CONTRACT_CODE_HASHES) {
      try {
        const viewer = await this.viewerFor(codeHash);
        const raw = await viewer.readStateRaw(
          parameters,
          LEGACY_BOARD_READ_TIMEOUT_MS,
        );
        return decodeLegacyV5State(raw);
      } catch {
        // No instance, unreadable, or not a pre-v6 board: next generation.
      }
    }
    return null;
  }

  private async doStart(): Promise<StateV3> {
    if (!this.config.contractCodeHash.trim()) {
      throw new ContractBuildError(
        "ContractBuildMissing",
        "Contract build configuration is missing: no contract code hash was injected. " +
          "Build number_contract.wasm, run the UI build script to write " +
          "ui/contract_code_hash.txt and public/number_contract.wasm, then rebuild.",
      );
    }

    this.callbacks.onStatus("starting");

    try {
      try {
        this.contract = new NumberContract(
          this.config.contractCodeHash,
          this.config.contractWasmUrl,
          {
            onStatus: (status, detail) => this.handleContractStatus(status, detail),
            onState: (state) => {
              this.currentState = state;
              this.callbacks.onState(state);
            },
            onError: (message, cause) => {
              for (const client of this.delegateClients) {
                client.handleHostError(message);
              }
              // A missing predecessor is an expected probe outcome; do not
              // surface it as a board error. Real failures still surface from
              // the identity/load step after migration.
              if (!this.migrating) {
                this.callbacks.onError(
                  cause instanceof Error ? cause : new Error(message),
                );
              }
            },
            onNotification: (update) => this.handleNotification(update),
            onDelegateResponse: (response) => {
              // Broadcast to every client with a pending request. Migration
              // temporarily has a predecessor client in this list; the main
              // client ignores a response when it has nothing pending.
              for (const client of this.delegateClients) {
                client.handleResponse(response);
              }
            },
          },
        );
      } catch (error) {
        throw new ContractBuildError(
          "ContractBuildMissing",
          `Contract build configuration is invalid: ${errorMessage(error)}`,
        );
      }

      this.callbacks.onStatus("connecting", "opening WebSocket");
      await this.contract.connect();
      await this.ensureDelegate();

      this.callbacks.onStatus("identity", "checking for a legacy identity");
      this.migrating = true;
      try {
        await this.migrateDelegateSecrets();
      } finally {
        this.migrating = false;
      }

      // First run, and no legacy predecessor answered: let the user create an
      // identity or import a backup before anything creates a seed. A delegate
      // refuses import once a seed exists, so this is the only safe moment.
      const status = await this.delegate.status().catch(() => null);
      if (status && !status.hasSeed && this.callbacks.onIdentityRequired) {
        this.callbacks.onStatus("identity", "no identity on this device yet");
        await this.callbacks.onIdentityRequired();
      }

      this.callbacks.onStatus("identity", "asking the delegate for the owner key");
      const identity = await this.delegate.identity();
      this.identity = identity;
      this.callbacks.onIdentity(identity);

      // The address book is delegate-owned in v6. Read it before the first
      // state render so slot labels and the editor's contact list are ready.
      await this.refreshContacts();

      const parameters = hexToBytes(identity.pubkey);
      if (parameters.length !== 32) {
        throw new Error(
          `delegate pubkey must be 32 bytes, got ${parameters.length}`,
        );
      }

      this.callbacks.onStatus("connecting", "loading the zone");
      const state = await this.contract.ensureState(
        parameters,
        LEGACY_CONTRACT_CODE_HASHES,
        // v5→v6: the old board's address book moves into the delegate and the
        // name records are signed before the first PUT. Throwing here aborts
        // the PUT, so a half-migrated board is impossible.
        (raw, codeHash) => this.upgradeLegacyBoard(raw, codeHash),
      );
      this.currentState = state;

      const key = this.contract.contractKeyBase58;
      if (key) {
        this.contractKeyBase58 = key;
        this.callbacks.onContractKey(key);
      }

      this.started = true;
      this.callbacks.onState(state);
      this.callbacks.onStatus("ready");
      // Configure after the board is usable: the delegate must already own the
      // migrated/created seed, and the address walk may need to read a parent
      // board. It must not delay the first render; a failure is non-fatal
      // (auto-advance stays inert) and is reported as a warning.
      this.delegateStatus = null;
      // Reconcile with an untouched legacy instance, then configure: records
      // from a stale bundle are healed and the old address book is imported
      // once, both off the first-render path. Serialised through the configure
      // chain so the legacy viewers are not used by two address walks at once.
      void this.reconfigureDelegate().then(() =>
        this.reconcileLegacyGeneration(),
      );
      return state;
    } catch (error) {
      this.started = false;
      this.delegate.failAll(errorMessage(error));
      const contract = this.contract;
      this.contract = null;
      contract?.close();
      this.callbacks.onStatus("error", errorMessage(error));
      throw error;
    }
  }

  private handleContractStatus(status: ConnectionStatus, detail?: string): void {
    if (status === "connecting" || status === "connected") {
      this.callbacks.onStatus("connecting", detail);
    } else if (status === "disconnected") {
      this.delegate.failAll(detail ?? "Disconnected from the Freenet node.");
      this.callbacks.onStatus("disconnected", detail);
    } else if (status === "error") {
      this.callbacks.onStatus("error", detail);
    }
  }

  private handleNotification(update: ContractUpdate): void {
    if (!this.currentState) {
      void this.refresh();
      return;
    }

    try {
      if (update.kind === "delta") {
        if (update.delta.length === 0) return; // converged / no-op notification
        const next = mergeDelta(this.currentState, decodeDelta(update.delta));
        this.currentState = next;
        this.callbacks.onState(next);
        void this.reconfigureDelegate();
        return;
      }

      if (update.kind === "state") {
        const next = decodeState(update.state);
        this.currentState = next;
        this.callbacks.onState(next);
        void this.reconfigureDelegate();
        return;
      }

      const base = decodeState(update.state);
      const next = mergeDelta(base, decodeDelta(update.delta));
      this.currentState = next;
      this.callbacks.onState(next);
      void this.reconfigureDelegate();
    } catch (error) {
      this.callbacks.onError(
        new Error(`Rejected a live update from the node: ${errorMessage(error)}`),
      );
      void this.refresh();
    }
  }

  async save(slotIndex: number, entry: Entry): Promise<void> {
    await this.write(slotIndex, validateEntry(entry));
  }

  async clear(slotIndex: number): Promise<void> {
    await this.write(slotIndex, null);
  }

  /**
   * Read the delegate's private address book. A delegate that predates v9 has
   * no `contacts` command; treat that as an empty book rather than failing the
   * board, because names are signed records and do not depend on it.
   *
   * A genuine read failure is different: the cache is left as it was (never
   * replaced with a fake empty book) and the user is told once. The migration
   * and repair paths check `contactsReadable` before importing anything.
   */
  private async refreshContacts(): Promise<ContactRecord[]> {
    try {
      this.contactsCache = await this.delegate.listContacts();
      this.contactsReadable = true;
    } catch (error) {
      this.contactsReadable = false;
      console.warn(
        "[delegate] could not read the private address book:",
        errorMessage(error),
      );
      if (!this.contactsReadWarningShown) {
        this.contactsReadWarningShown = true;
        this.callbacks.onWarning?.(
          `Could not read the private address book: ${errorMessage(error)}. ` +
            "No contact was imported; the book is shown as last seen.",
        );
      }
    }
    return this.contactsCache;
  }

  async listContacts(): Promise<ContactRecord[]> {
    return this.refreshContacts();
  }

  /**
   * Address-book mutations never touch contract state. The delegate answers
   * with the resulting array, which becomes the cached list; a repaint follows
   * so every open view (grid, editor, dialog) sees the same book.
   */
  async addContact(entry: {
    label: string;
    userId: string;
    address?: string | null;
  }): Promise<ContactRecord[]> {
    this.contactsCache = await this.delegate.addContact(entry);
    this.contactsReadable = true;
    this.repaintAfterContactsChange();
    return this.contactsCache;
  }

  async updateContact(
    userId: string,
    patch: { label?: string; address?: string | null },
  ): Promise<ContactRecord[]> {
    this.contactsCache = await this.delegate.updateContact(userId, patch);
    this.contactsReadable = true;
    this.repaintAfterContactsChange();
    return this.contactsCache;
  }

  async removeContact(userId: string): Promise<ContactRecord[]> {
    this.contactsCache = await this.delegate.removeContact(userId);
    this.contactsReadable = true;
    this.repaintAfterContactsChange();
    return this.contactsCache;
  }

  private repaintAfterContactsChange(): void {
    if (this.currentState) this.callbacks.onState(this.currentState);
  }

  /**
   * Set (or clear with null) the signed parent link. Same optimistic/rollback
   * shape and single-write guard as `write`. The seq beats both the contract's
   * record and the delegate's parent counter.
   */
  async saveParent(userId: string | null): Promise<void> {
    if (userId !== null) {
      if (!isLowerHex(userId, 64)) {
        throw new Error(
          "The parent must be a 64-character lowercase hex user id.",
        );
      }
      if (this.identity && userId === this.identity.pubkey) {
        throw new Error("A zone cannot be its own parent.");
      }
    }

    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The zone is not connected yet");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    const previous = this.currentState;
    let updateStarted = false;

    try {
      const seq = Math.max(
        previous.parent.seq + 1,
        this.identity.parentNextSeq ?? 1,
      );
      const sig = await this.delegate.signParent(seq, userId);

      const delta: Delta = {
        v: 6,
        parent: { seq, userId, sig },
        selfName: null,
        childNames: null,
        payments: null,
        adjustments: null,
        slots: [],
      };

      const optimistic = mergeDelta(previous, delta);
      this.currentState = optimistic;
      this.callbacks.onState(optimistic);

      this.identity = { ...this.identity, parentNextSeq: seq + 1 };
      this.callbacks.onIdentity(this.identity);

      updateStarted = true;
      await this.contract.updateDelta(delta);

      try {
        const fresh = await this.contract.getState();
        this.currentState = fresh;
        this.callbacks.onState(fresh);
      } catch (error) {
        this.callbacks.onWarning?.(
          `Saved the parent link, but could not refresh the zone: ${errorMessage(error)}`,
        );
      }

      // The parent link determines the octal address the delegate validates.
      await this.reconfigureDelegate();
    } catch (error) {
      this.currentState = previous;
      this.callbacks.onState(previous);
      if (updateStarted) void this.refresh();
      throw error;
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Sign the payments record and every slot write it made, then send them as
   * one delta. Same optimistic/rollback shape and single-write guard as
   * `write`. The payments seq beats both the contract's record and the
   * delegate's payments counter; slot seqs use the existing slot helper.
   *
   * Returns the signed entry. Forward intents (`legs: []`) gain one leg per slot
   * write; reversal records keep their existing legs so the reversal engine can
   * compare exactly what was originally signed.
   */
  async savePayment(
    entry: PaymentEntry | null,
    slots: PaymentSlotWrite[],
  ): Promise<PaymentEntry | null> {
    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The zone is not connected yet");
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
    const previous = this.currentState;
    let updateStarted = false;

    try {
      const paymentsSeq = Math.max(
        previous.payments.seq + 1,
        this.identity.paymentsNextSeq ?? 1,
      );

      // Sign the slot writes first: their seq/sig/postValue become the payment
      // legs, and the payments signature must cover those completed legs.
      const deltaSlots: DeltaSlot[] = [];
      const newLegs: PaymentEntry["legs"] = [];
      const nextSeq = [...this.identity.nextSeq];
      for (const write of writes) {
        const seq = this.nextSlotSeq(previous, this.identity, write.index);
        const sig = await this.delegate.sign(write.index, seq, write.entry);
        deltaSlots.push({ i: write.index, seq, entry: write.entry, sig });
        newLegs.push({ slot: write.index, seq, postValue: write.entry.value, sig });
        nextSeq[write.index] = seq + 1;
      }

      // A forward intent starts with no legs and gains them from this actor's
      // slot writes. A reversal record already carries the legs being undone;
      // preserve them byte-for-byte.
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

      // A source intent's id is derived from the payments sequence that is
      // actually signed, not the caller's possibly stale estimate. The
      // collapsed `dS = 0` source record is at cursor 1 and already carries its
      // leg (and may already be complete), so this covers every
      // source-originated forward/complete record, not just cursor 0.
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

      // Carry the bounded settled list through the signature. Replacing or
      // clearing a different entry appends the outgoing id (see nextSettled).
      const settled = nextSettled(previous.payments, signedEntry);

      const paymentsSig = await this.delegate.signPayments(
        paymentsSeq,
        signedEntry,
        settled,
      );

      const delta: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames: null,
        payments: {
          seq: paymentsSeq,
          settled,
          entry: signedEntry,
          sig: paymentsSig,
        },
        adjustments: null,
        slots: deltaSlots,
      };

      const optimistic = mergeDelta(previous, delta);
      this.currentState = optimistic;
      this.callbacks.onState(optimistic);

      this.identity = {
        ...this.identity,
        nextSeq,
        paymentsNextSeq: paymentsSeq + 1,
      };
      this.callbacks.onIdentity(this.identity);

      updateStarted = true;
      await this.contract.updateDelta(delta);

      try {
        const fresh = await this.contract.getState();
        this.currentState = fresh;
        this.callbacks.onState(fresh);
      } catch (error) {
        this.callbacks.onWarning?.(
          `Saved the payment, but could not refresh the zone: ${errorMessage(error)}`,
        );
      }

      return signedEntry;
    } catch (error) {
      this.currentState = previous;
      this.callbacks.onState(previous);
      if (updateStarted) void this.refresh();
      throw error;
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Clear a stuck non-terminal payment on the owner's own board by signing a
   * payments tombstone at the next seq. The stale id joins `settled`; the
   * entry becomes null. This only clears the board's own record; it does not
   * move value and does not touch any other board.
   */
  async clearStuckPayment(): Promise<void> {
    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The zone is not connected yet");
    }
    const payments = this.currentState.payments;
    if (payments.entry === null) return;
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    const previous = this.currentState;
    try {
      const seq = Math.max(payments.seq + 1, this.identity.paymentsNextSeq ?? 1);
      const settled = nextSettled(payments, null);
      const sig = await this.delegate.signPayments(seq, null, settled);
      const delta: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames: null,
        payments: { seq, settled, entry: null, sig },
        adjustments: null,
        slots: [],
      };
      const optimistic = mergeDelta(previous, delta);
      this.currentState = optimistic;
      this.callbacks.onState(optimistic);
      this.identity = { ...this.identity, paymentsNextSeq: seq + 1 };
      this.callbacks.onIdentity(this.identity);

      await this.contract.updateDelta(delta);
      try {
        const fresh = await this.contract.getState();
        this.currentState = fresh;
        this.callbacks.onState(fresh);
      } catch (error) {
        this.callbacks.onWarning?.(
          `Cleared the stuck payment, but could not refresh the zone: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      this.currentState = previous;
      this.callbacks.onState(previous);
      throw error;
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Sign an issue (positive delta) or burn (negative delta) to one slot's
   * liability. The slot entry keeps its contact/unit/note and moves to the new
   * value; one signed v5 adjustment records the slot write that produced it.
   * Both travel in a single delta. Deltas are hundredths; burn clamps at 0 by
   * rejecting the write rather than storing a negative value.
   */
  async issueOrBurn(
    slotIndex: number,
    delta: bigint,
    note: string,
  ): Promise<void> {
    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The zone is not connected yet");
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 7) {
      throw new Error(`slot must be in 0..7, got ${slotIndex}`);
    }
    if (typeof delta !== "bigint" || delta === 0n) {
      throw new Error("delta must be a non-zero bigint (hundredths).");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    const previous = this.currentState;
    const slot = previous.slots[slotIndex];
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

    const slotSeq = this.nextSlotSeq(previous, this.identity, slotIndex);
    const adjustment: Adjustment = validateAdjustment({
      slot: slotIndex,
      slotSeq,
      delta: BigInt(delta),
      postValue: newValue,
      note: optionalText(note),
    });
    // The log is capped; the oldest entry drops off the front.
    const entries = [...previous.adjustments.entries, adjustment];
    const capped =
      entries.length > MAX_ADJUSTMENTS
        ? entries.slice(entries.length - MAX_ADJUSTMENTS)
        : entries;
    // Validate before signing the slot so a bad note/log cannot write a slot
    // without its matching adjustment.
    validateAdjustmentList(capped);

    this.mutating = true;
    let updateStarted = false;

    try {
      const entry: Entry = { ...slot.entry, value: newValue };
      const sig = await this.delegate.sign(slotIndex, slotSeq, entry);

      const adjustmentsSeq = Math.max(
        previous.adjustments.seq + 1,
        this.identity.adjustmentsNextSeq ?? 1,
      );
      const signed = await this.delegate.signAdjustment(adjustmentsSeq, capped);

      const delta: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames: null,
        payments: null,
        adjustments: { seq: signed.seq, entries: capped, sig: signed.sig },
        slots: [{ i: slotIndex, seq: slotSeq, entry, sig }],
      };

      const optimistic = mergeDelta(previous, delta);
      this.currentState = optimistic;
      this.callbacks.onState(optimistic);

      this.identity = {
        ...this.identity,
        nextSeq: this.identity.nextSeq.map((value, index) =>
          index === slotIndex ? slotSeq + 1 : value,
        ),
        adjustmentsNextSeq: signed.seq + 1,
      };
      this.callbacks.onIdentity(this.identity);

      updateStarted = true;
      await this.contract.updateDelta(delta);

      try {
        const fresh = await this.contract.getState();
        this.currentState = fresh;
        this.callbacks.onState(fresh);
      } catch (error) {
        this.callbacks.onWarning?.(
          `Saved the issue/burn, but could not refresh the zone: ${errorMessage(error)}`,
        );
      }

      // Keep the delegate pointing at the active v5 instance and the legacy
      // generations it may still need to read.
      await this.reconfigureDelegate();
    } catch (error) {
      this.currentState = previous;
      this.callbacks.onState(previous);
      if (updateStarted) void this.refresh();
      throw error;
    } finally {
      this.mutating = false;
    }
  }

  /** DESIGN §8 slot seq: max(contract.seq + 1, delegate.nextSeq). */
  private nextSlotSeq(
    state: StateV3,
    identity: DelegateIdentity,
    index: number,
  ): number {
    return Math.max(state.slots[index].seq + 1, identity.nextSeq[index] ?? 1);
  }

  /**
   * Read one board by owner id. The own board comes from the in-memory state;
   * any other owner is read through a lazy read-only viewer, trying the current
   * code hash first and then each legacy (v2) generation. Returns null when no
   * instance holds a readable state.
   */
  async readBoard(ownerId: string): Promise<BoardSnapshot | null> {
    if (!isLowerHex(ownerId, 64)) {
      throw new Error(
        `The zone owner must be a 64-character lowercase hex user id, got ${JSON.stringify(ownerId)}`,
      );
    }

    if (this.identity && ownerId === this.identity.pubkey) {
      if (!this.currentState) return null;
      return {
        ownerId,
        state: this.currentState,
        contacts: this.contacts,
        codeHash: this.config.contractCodeHash,
        legacy: false,
      };
    }

    const parameters = hexToBytes(ownerId);
    for (const codeHash of [
      this.config.contractCodeHash,
      ...LEGACY_CONTRACT_CODE_HASHES,
    ]) {
      const legacy = codeHash !== this.config.contractCodeHash;
      const timeout = legacy
        ? LEGACY_BOARD_READ_TIMEOUT_MS
        : CURRENT_BOARD_READ_TIMEOUT_MS;
      try {
        const viewer = await this.viewerFor(codeHash);
        const state = await viewer.readState(parameters, timeout);
        // Other owners' address books are private, so a remote board never has
        // one to show. Public slot labels come from its signed `childNames`.
        return { ownerId, state, contacts: [], codeHash, legacy };
      } catch {
        // No instance, unreadable state, or a timeout: try the next generation.
      }
    }
    return null;
  }

  /**
   * Subscribe to another owner's zone so an owner write reaches this node.
   *
   * Uses a dedicated viewer (never the shared read-only one) and no repainting
   * callbacks: only `onNotification` is wired, so the join panel decides how to
   * refresh. `subscribeState` registers a blocking subscription, which keeps a
   * write made after the initial GET from slipping past. Connect/subscribe
   * failures are logged and ignored; the returned cleanup is always callable.
   */
  watchBoard(ownerId: string, onChange: () => void): () => void {
    if (!isLowerHex(ownerId, 64)) {
      throw new Error(
        `The zone owner must be a 64-character lowercase hex user id, got ${JSON.stringify(ownerId)}`,
      );
    }

    const viewer = new NumberContract(
      this.config.contractCodeHash,
      this.config.contractWasmUrl,
      { onNotification: () => onChange() },
    );
    this.watchViewers.add(viewer);

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      this.watchViewers.delete(viewer);
      viewer.close();
    };

    void (async () => {
      try {
        await viewer.connect();
        await viewer.subscribeState(hexToBytes(ownerId));
      } catch (error) {
        // Cleanup or board.close() already stopped this watch: stay quiet.
        if (!this.watchViewers.has(viewer)) return;
        console.warn(
          `Could not subscribe to zone ${ownerId}: ${errorMessage(error)}`,
        );
        cleanup();
      }
    })();

    return cleanup;
  }

  private async viewerFor(codeHash: string): Promise<NumberContract> {
    const existing = this.viewers.get(codeHash);
    if (existing) {
      await existing.connect();
      return existing;
    }

    // No callbacks: a remote board must never feed the own board's state,
    // delegate queue, or error banner.
    const viewer = new NumberContract(codeHash, this.config.contractWasmUrl);
    this.viewers.set(codeHash, viewer);
    try {
      await viewer.connect();
    } catch (error) {
      this.viewers.delete(codeHash);
      viewer.close();
      throw error;
    }
    return viewer;
  }

  /** Ask the delegate for the seed and counters behind this identity. */
  exportIdentity(): Promise<ExportedSecrets> {
    return this.delegate.exportSecrets();
  }

  /**
   * Restore a backup into this delegate. The delegate refuses when a seed
   * already exists, so this only succeeds on a fresh device (normally from the
   * first-run prompt, before `identity()` creates anything).
   */
  async importIdentity(
    seed: string,
    nextSeq: number[],
    contactsNextSeq: number,
    parentNextSeq: number,
    paymentsNextSeq = 1,
    adjustmentsNextSeq = 1,
    childNamesNextSeq = 1,
    selfNameNextSeq = 1,
    payloadVersion = 1,
    contacts?: ContactRecord[],
  ): Promise<void> {
    await this.delegate.importSecrets(
      seed,
      nextSeq,
      contactsNextSeq,
      parentNextSeq,
      paymentsNextSeq,
      adjustmentsNextSeq,
      childNamesNextSeq,
      selfNameNextSeq,
      payloadVersion,
      contacts,
    );
    // A restored backup carries the private address book; make the in-memory
    // cache match before the board is read.
    await this.refreshContacts();
  }

  /**
   * Fetch the delegate WASM shipped with this site, verify it against the
   * injected code hash, and register it on the node.
   */
  async installDelegate(): Promise<void> {
    if (!this.contract || !this.delegate) {
      throw new Error("The Freenet connection is not open yet.");
    }
    let response: Response;
    try {
      response = await fetch(this.config.delegateWasmUrl);
    } catch (error) {
      throw new Error(
        `Could not download the delegate from ${this.config.delegateWasmUrl}: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Could not download the delegate from ${this.config.delegateWasmUrl} (HTTP ${response.status}).`,
      );
    }
    const code = new Uint8Array(await response.arrayBuffer());
    await this.delegate.register(code);
  }

  /**
   * Read the delegate's current auto-advance status. This is advisory UI state:
   * a transient failure leaves the previous value in place rather than failing
   * the board.
   */
  async refreshDelegateStatus(): Promise<DelegateStatus | null> {
    if (!this.contract) return this.delegateStatus;
    try {
      const status = await this.delegate.status();
      this.delegateStatus = status;
      this.callbacks.onDelegateStatus?.(status);
      return status;
    } catch (error) {
      console.warn(
        "[delegate] could not read auto-advance status:",
        errorMessage(error),
      );
      return this.delegateStatus;
    }
  }

  /**
   * Enable or disable auto-advance, optionally changing the per-payment cap.
   * The delegate must already be configured (the board configures it on
   * connect after the seed and address are known).
   */
  async setAutoAdvance(
    enabled: boolean,
    maxAmount?: number,
  ): Promise<void> {
    if (!this.contract) throw new Error("The zone is not connected yet");
    // Preserve the configured cap when the caller only flips the toggle.
    const cap = maxAmount ?? this.delegateStatus?.maxAmount ?? DEFAULT_MAX_AMOUNT;
    await this.delegate.setAutoAdvance(enabled, cap);
    await this.refreshDelegateStatus();
  }

  /**
   * Coalesce configure refreshes: a state notification that lands while an
   * address walk is still running queues exactly one follow-up.
   */
  private reconfigureDelegate(): Promise<void> {
    if (this.configuring) {
      this.configurationDirty = true;
      return this.configuring;
    }
    this.configuring = this.configureDelegate().finally(() => {
      this.configuring = null;
      if (this.configurationDirty) {
        this.configurationDirty = false;
        void this.reconfigureDelegate();
      }
    });
    return this.configuring;
  }

  /**
   * Recompute the owner's octal address and send `configure` with the active
   * contract hash first and every migratable legacy hash after it.
   *
   * This must never run before the delegate has a seed: the first-run and
   * predecessor-migration paths own seed creation, and configuring a fresh
   * delegate would make it look migrated. The board calls this only after
   * `identity()` (which follows migration) or after a successful import.
   */
  private async configureDelegate(): Promise<void> {
    if (!this.started || !this.identity || !this.currentState || !this.contract) {
      return;
    }

    const status =
      this.delegateStatus ?? (await this.refreshDelegateStatus());
    if (!status?.hasSeed) return; // first-run/migration owns the seed creation

    let address: string | null;
    try {
      address = await this.ownOctalAddress();
    } catch (error) {
      this.callbacks.onWarning?.(
        `Could not determine this zone's address for auto-advance: ${errorMessage(error)}`,
      );
      return;
    }
    if (address === null) return; // pending/unreadable parent: retry on next change

    const codeHashes = [
      this.config.contractCodeHash,
      ...LEGACY_CONTRACT_CODE_HASHES,
    ];

    // Reconfiguring must not reset a user's policy back to the defaults: a
    // status notification can arrive at any time and calls this again. An
    // unconfigured v8 delegate starts on (the documented default).
    const autoAdvance = status.configured ? status.autoAdvance : true;
    const maxAmount = status.configured ? status.maxAmount : DEFAULT_MAX_AMOUNT;

    try {
      await this.delegate.configure(codeHashes, address, autoAdvance, maxAmount);
      await this.refreshDelegateStatus();
    } catch (error) {
      this.callbacks.onWarning?.(
        `Could not configure delegate auto-advance: ${errorMessage(error)}`,
      );
    }
  }

  /** Octal address of this board, derived from the signed parent chain. */
  private async ownOctalAddress(): Promise<string | null> {
    if (!this.identity || !this.currentState) return null;
    const info = await octalAddress(
      {
        ownerId: this.identity.pubkey,
        state: this.currentState,
        contacts: this.contacts,
        codeHash: this.config.contractCodeHash,
        legacy: false,
      },
      { readBoard: (ownerId) => this.readBoard(ownerId) },
    );
    return info.address;
  }

  /**
   * The `childNames` record a slot write implies. A parent names each child by
   * its own slot index, so saving a slot (re)writes that slot's entry with the
   * selected contact's label; clearing the slot removes it. The record is only
   * re-signed when its entries actually change. A signed name whose contact has
   * since been removed from the private book is preserved while it still
   * describes this slot.
   */
  private async nextChildNamesForSlot(
    state: StateV3,
    identity: DelegateIdentity,
    slotIndex: number,
    entry: Entry | null,
  ): Promise<ChildNames | null> {
    const current = state.childNames;
    const existing = current.entries.find(
      (candidate) => candidate.slot === slotIndex,
    );
    const contact =
      entry === null
        ? null
        : (this.contactsCache.find(
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
    const validated = validateChildNameList(entries);
    if (JSON.stringify(validated) === JSON.stringify(current.entries)) {
      return null;
    }

    const seq = Math.max(current.seq + 1, identity.childNamesNextSeq ?? 1);
    const sig = await this.delegate.signChildNames(seq, validated);
    return { seq, entries: validated, sig };
  }

  private async write(slotIndex: number, entry: Entry | null): Promise<void> {
    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The zone is not connected yet");
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 7) {
      throw new Error(`slot must be in 0..7, got ${slotIndex}`);
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    const previous = this.currentState;
    let updateStarted = false;

    try {
      // DESIGN §8: max(contract.seq, delegate.nextSeq). `+ 1` only matters if
      // the contract advanced without the delegate's counter (e.g. delegate
      // storage was reset): it guarantees the new delta actually wins.
      const seq = this.nextSlotSeq(previous, this.identity, slotIndex);

      const sig = await this.delegate.sign(slotIndex, seq, entry);
      const childNames = await this.nextChildNamesForSlot(
        previous,
        this.identity,
        slotIndex,
        entry,
      );

      const delta: Delta = {
        v: 6,
        parent: null,
        selfName: null,
        childNames,
        payments: null,
        adjustments: null,
        slots: [{ i: slotIndex, seq, entry, sig }],
      };

      // Optimistic display, using the contract's own merge rule.
      const optimistic = mergeDelta(previous, delta);
      this.currentState = optimistic;
      this.callbacks.onState(optimistic);

      // The delegate stored seq+1 even before the update lands.
      this.identity = {
        ...this.identity,
        nextSeq: this.identity.nextSeq.map((value, index) =>
          index === slotIndex ? seq + 1 : value,
        ),
        childNamesNextSeq:
          childNames === null
            ? this.identity.childNamesNextSeq
            : childNames.seq + 1,
      };
      this.callbacks.onIdentity(this.identity);

      updateStarted = true;
      await this.contract.updateDelta(delta);

      // Reconcile with the authoritative merged state. A failed follow-up GET
      // must not turn a successful write into a reported failure.
      try {
        const fresh = await this.contract.getState();
        this.currentState = fresh;
        this.callbacks.onState(fresh);
      } catch (error) {
        this.callbacks.onWarning?.(
          `Saved, but could not refresh the zone: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      this.currentState = previous;
      this.callbacks.onState(previous);
      if (updateStarted) void this.refresh();
      throw error;
    } finally {
      this.mutating = false;
    }
  }

  private async refresh(): Promise<void> {
    if (!this.contract) return;
    try {
      const state = await this.contract.getState();
      this.currentState = state;
      this.callbacks.onState(state);
    } catch (error) {
      this.callbacks.onError(
        new Error(`Could not refresh the zone: ${errorMessage(error)}`),
      );
    }
  }

  async retry(): Promise<StateV3> {
    this.close();
    return this.start();
  }

  close(): void {
    this.started = false;
    this.configurationDirty = false;
    if (this.delegateStatus !== null) {
      this.delegateStatus = null;
      this.callbacks.onDelegateStatus?.(null);
    }
    this.delegate.failAll();
    for (const viewer of this.viewers.values()) viewer.close();
    this.viewers.clear();
    for (const viewer of this.watchViewers) viewer.close();
    this.watchViewers.clear();
    this.roomTransportValue?.close();
    this.roomTransportValue = null;
    this.candidateTransportValue?.close();
    this.candidateTransportValue = null;
    this.contract?.close();
    this.contract = null;
  }
}
