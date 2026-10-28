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
  DelegateClient,
  DelegateError,
  type DelegateIdentity,
  type ExportedSecrets,
} from "./delegate";
import {
  decodeDelta,
  decodeState,
  entryFromInputs,
  mergeDelta,
  validateContactList,
  validateEntry,
  type Contact,
  type Delta,
  type Entry,
  type StateV3,
} from "./state";
import { errorMessage, hexToBytes, isLowerHex } from "./util";

export { entryFromInputs };

/**
 * Tree reads are best-effort. A missing instance can surface as a 12 s GET
 * timeout on this node, so do not let a missing child/parent stall navigation
 * for the full request budget; try the next legacy generation quickly.
 */
const BOARD_READ_TIMEOUT_MS = 4_000;

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
  /** Base58 code hash of the contract instance the state was read from. */
  codeHash: string;
  /** True when the state came from a superseded (v2) contract generation. */
  legacy: boolean;
}

export interface BoardBackend {
  readonly mode: "online" | "offline";
  readonly identity: DelegateIdentity | null;
  readonly contractKeyBase58: string | null;
  readonly currentState: StateV3 | null;
  start(): Promise<StateV3>;
  save(slotIndex: number, entry: Entry): Promise<void>;
  clear(slotIndex: number): Promise<void>;
  /** Replace the signed address book with `entries`. */
  saveContacts(entries: Contact[]): Promise<void>;
  /** Set (or clear with null) this board's signed parent link. */
  saveParent(userId: string | null): Promise<void>;
  /** Read one board by owner id; null when no instance/state exists. */
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
  retry(): Promise<StateV3>;
  /** Export the owner seed and counters for a backup. */
  exportIdentity(): Promise<ExportedSecrets>;
  /** Restore a seed into a delegate that has none (a new device). */
  importIdentity(
    seed: string,
    nextSeq: number[],
    contactsNextSeq: number,
    parentNextSeq: number,
  ): Promise<void>;
  /** Register the bundled delegate on this node (a fresh device). */
  installDelegate(): Promise<void>;
  close(): void;
}

export class OnlineBoard implements BoardBackend {
  readonly mode = "online" as const;

  identity: DelegateIdentity | null = null;
  contractKeyBase58: string | null = null;
  currentState: StateV3 | null = null;

  private contract: NumberContract | null = null;
  private readonly delegate: DelegateClient;
  private readonly delegateClients: DelegateClient[] = [];
  /** Read-only viewers for other owners' boards, keyed by code hash. */
  private readonly viewers = new Map<string, NumberContract>();
  private migrating = false;
  private started = false;
  private startPromise: Promise<StateV3> | null = null;
  private mutating = false;

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

      const parameters = hexToBytes(identity.pubkey);
      if (parameters.length !== 32) {
        throw new Error(
          `delegate pubkey must be 32 bytes, got ${parameters.length}`,
        );
      }

      this.callbacks.onStatus("connecting", "loading the board");
      const state = await this.contract.ensureState(
        parameters,
        LEGACY_CONTRACT_CODE_HASHES,
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
        return;
      }

      if (update.kind === "state") {
        const next = decodeState(update.state);
        this.currentState = next;
        this.callbacks.onState(next);
        return;
      }

      const base = decodeState(update.state);
      const next = mergeDelta(base, decodeDelta(update.delta));
      this.currentState = next;
      this.callbacks.onState(next);
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
   * Write the whole address book as one signed contacts record. Same
   * optimistic/rollback shape as `write`, and the same single-write guard.
   */
  async saveContacts(entries: Contact[]): Promise<void> {
    const normalised = entries.map((entry) => ({
      label: entry.label.trim(),
      userId: entry.userId.trim().toLowerCase(),
    }));
    const validated = validateContactList(normalised);

    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The board is not connected yet");
    }
    if (this.mutating) throw new Error("Another change is still in progress");

    this.mutating = true;
    const previous = this.currentState;
    let updateStarted = false;

    try {
      // Same rule as slots: beat the contract's record and the delegate counter.
      const seq = Math.max(
        previous.contacts.seq + 1,
        this.identity.contactsNextSeq ?? 1,
      );
      const sig = await this.delegate.signContacts(seq, validated);

      const delta: Delta = {
        v: 3,
        parent: null,
        contacts: { seq, entries: validated, sig },
        slots: [],
      };

      const optimistic = mergeDelta(previous, delta);
      this.currentState = optimistic;
      this.callbacks.onState(optimistic);

      this.identity = { ...this.identity, contactsNextSeq: seq + 1 };
      this.callbacks.onIdentity(this.identity);

      updateStarted = true;
      await this.contract.updateDelta(delta);

      try {
        const fresh = await this.contract.getState();
        this.currentState = fresh;
        this.callbacks.onState(fresh);
      } catch (error) {
        this.callbacks.onWarning?.(
          `Saved the address book, but could not refresh the board: ${errorMessage(error)}`,
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
        throw new Error("A board cannot be its own parent.");
      }
    }

    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The board is not connected yet");
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
        v: 3,
        parent: { seq, userId, sig },
        contacts: null,
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
          `Saved the parent link, but could not refresh the board: ${errorMessage(error)}`,
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

  /**
   * Read one board by owner id. The own board comes from the in-memory state;
   * any other owner is read through a lazy read-only viewer, trying the current
   * code hash first and then each legacy (v2) generation. Returns null when no
   * instance holds a readable state.
   */
  async readBoard(ownerId: string): Promise<BoardSnapshot | null> {
    if (!isLowerHex(ownerId, 64)) {
      throw new Error(
        `The board owner must be a 64-character lowercase hex user id, got ${JSON.stringify(ownerId)}`,
      );
    }

    if (this.identity && ownerId === this.identity.pubkey) {
      if (!this.currentState) return null;
      return {
        ownerId,
        state: this.currentState,
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
      try {
        const viewer = await this.viewerFor(codeHash);
        const state = await viewer.readState(parameters, BOARD_READ_TIMEOUT_MS);
        return { ownerId, state, codeHash, legacy };
      } catch {
        // No instance, unreadable state, or a timeout: try the next generation.
      }
    }
    return null;
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
  ): Promise<void> {
    await this.delegate.importSecrets(
      seed,
      nextSeq,
      contactsNextSeq,
      parentNextSeq,
    );
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

  private async write(slotIndex: number, entry: Entry | null): Promise<void> {
    if (!this.started || !this.currentState || !this.identity || !this.contract) {
      throw new Error("The board is not connected yet");
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
      const contractSeq = previous.slots[slotIndex].seq;
      const delegateNext = this.identity.nextSeq[slotIndex] ?? 1;
      const seq = Math.max(contractSeq + 1, delegateNext);

      const sig = await this.delegate.sign(slotIndex, seq, entry);

      const delta: Delta = {
        v: 3,
        parent: null,
        contacts: null,
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
          `Saved, but could not refresh the board: ${errorMessage(error)}`,
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
        new Error(`Could not refresh the board: ${errorMessage(error)}`),
      );
    }
  }

  async retry(): Promise<StateV3> {
    this.close();
    return this.start();
  }

  close(): void {
    this.started = false;
    this.delegate.failAll();
    for (const viewer of this.viewers.values()) viewer.close();
    this.viewers.clear();
    this.contract?.close();
    this.contract = null;
  }
}
