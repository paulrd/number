/**
 * Freenet WebSocket layer for the `number` board.
 *
 * The node derives a parameterised contract's instance id as
 *
 *   BLAKE3(code_hash_bytes || parameters)
 *
 * exactly like `freenet_stdlib::ContractKey::generate_id`. Here the parameters
 * are the owner's raw 32-byte Ed25519 verifying key. GET/UPDATE/SUBSCRIBE take
 * the reader `ContractKey`; PUT must use the packable `…T` twin or flatbuffers
 * throws "field 8 must be set" (see the microblogging reference).
 */

import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import {
  ContractKey,
  ContractType as WasmContractType,
  DeltaUpdate,
  DisconnectRequest,
  FreenetWsApi,
  GetRequest,
  PutRequest,
  SubscribeRequest,
  UpdateData,
  UpdateDataType,
  UpdateRequest,
  type DelegateResponse,
  type HostError,
  type ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import {
  ContractCodeT,
  ContractContainerT,
  ContractInstanceIdT,
  ContractKeyT,
  WasmContractV1T,
} from "@freenetorg/freenet-stdlib/common";
import {
  RelatedContractsT,
  type ClientRequestT,
} from "@freenetorg/freenet-stdlib/client-request";
import {
  decodeState,
  emptyState,
  encodeDelta,
  encodeState,
  type Delta,
  type StateV2,
} from "./state";
import { errorMessage, withTimeout } from "./util";

const CONNECT_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 12_000;
// Probe budget before deciding an instance is absent. A real not-found can take
// the full network-search path, and a timeout is treated the same way (PUT over
// an existing instance is a merge no-op), so this is the first-run latency.
const PROBE_TIMEOUT_MS = 4_000;
const PUT_TIMEOUT_MS = 35_000;
const SUBSCRIBE_TIMEOUT_MS = 12_000;
const UPDATE_TIMEOUT_MS = 30_000;

export function decodeCodeHash(codeHashBase58: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(codeHashBase58);
  } catch (error) {
    throw new Error(`contract code hash is not valid base58: ${errorMessage(error)}`);
  }
  if (bytes.length !== 32) {
    throw new Error(`contract code hash must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function encodeBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

/** instance_id = BLAKE3(code_hash_bytes || parameters). */
export function deriveInstanceIdFromBytes(
  codeHashBytes: Uint8Array,
  parameters: Uint8Array,
): { bytes: Uint8Array; base58: string } {
  if (codeHashBytes.length !== 32) {
    throw new Error(`code hash must be 32 bytes, got ${codeHashBytes.length}`);
  }
  const concat = new Uint8Array(codeHashBytes.length + parameters.length);
  concat.set(codeHashBytes, 0);
  concat.set(parameters, codeHashBytes.length);
  const id = blake3(concat);
  return { bytes: id, base58: bs58.encode(id) };
}

export function deriveInstanceId(
  codeHashBase58: string,
  parameters: Uint8Array,
): { bytes: Uint8Array; base58: string } {
  return deriveInstanceIdFromBytes(decodeCodeHash(codeHashBase58), parameters);
}

export function deriveContractKey(
  codeHashBase58: string,
  parameters: Uint8Array,
): ContractKey {
  const instance = deriveInstanceId(codeHashBase58, parameters);
  const codeBytes = decodeCodeHash(codeHashBase58);
  // The published d.ts types the first argument as the reader
  // ContractInstanceId; the runtime constructor also accepts the raw 32 bytes.
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

/** Packable ContractKey used by the PUT container (GET/UPDATE use the reader). */
export function deriveContractKeyTFromParts(
  codeHashBytes: Uint8Array,
  parameters: Uint8Array,
): ContractKeyT {
  const instance = deriveInstanceIdFromBytes(codeHashBytes, parameters);
  return new ContractKeyT(
    new ContractInstanceIdT(Array.from(instance.bytes)),
    Array.from(codeHashBytes),
  );
}

export function buildNumberPutRequest(
  wasm: Uint8Array,
  codeHashBytes: Uint8Array,
  parameters: Uint8Array,
  initialState: Uint8Array,
): PutRequest {
  const code = new ContractCodeT(Array.from(wasm), Array.from(codeHashBytes));
  const keyT = deriveContractKeyTFromParts(codeHashBytes, parameters);
  const contract = new WasmContractV1T(code, Array.from(parameters), keyT);
  const container = new ContractContainerT(WasmContractType.WasmContractV1, contract);
  return new PutRequest(
    container,
    Array.from(initialState),
    // Required flatbuffer field — undefined fails to serialize.
    new RelatedContractsT([]),
    false,
    false,
  );
}

export type ContractBuildErrorCode =
  | "ContractBuildMissing"
  | "ContractBuildMismatch";

export class ContractBuildError extends Error {
  readonly code: ContractBuildErrorCode;

  constructor(code: ContractBuildErrorCode, message: string) {
    super(message);
    this.name = "ContractBuildError";
    this.code = code;
  }
}

/**
 * The node answered GET with NotFound. FreenetWsApi reports this through the
 * `onContractNotFound` handler rather than rejecting the `get()` promise, so
 * `getState()` races the request against this signal. In practice the node
 * often does not deliver NotFound within the probe window (see DESIGN §11), so
 * any GET failure is treated as "maybe missing" and followed by a PUT.
 */
export class ContractNotFoundError extends Error {
  constructor() {
    super("Contract not found");
    this.name = "ContractNotFoundError";
  }
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type ContractUpdate =
  | { kind: "delta"; delta: Uint8Array }
  | { kind: "state"; state: Uint8Array }
  | { kind: "state-and-delta"; state: Uint8Array; delta: Uint8Array };

export interface NumberContractCallbacks {
  onState?: (state: StateV2) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onError?: (message: string, cause?: unknown) => void;
  onNotFound?: () => void;
  onNotification?: (update: ContractUpdate) => void;
  onDelegateResponse?: (response: DelegateResponse) => void;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

/**
 * Normalise the two shapes stdlib can hand us: live notifications carry
 * `UpdateDataT` plain objects (DeltaUpdateT has `.delta: number[]`), while a
 * hypothetical reader would carry classes with `.deltaArray()`.
 */
function extractUpdate(rawUpdate: unknown): ContractUpdate | null {
  if (typeof rawUpdate !== "object" || rawUpdate === null) return null;

  let value: Record<string, unknown>;
  const maybeReader = rawUpdate as { unpack?: () => unknown; bb?: unknown };
  if (typeof maybeReader.unpack === "function" && maybeReader.bb !== undefined) {
    try {
      const unpacked = maybeReader.unpack();
      if (typeof unpacked !== "object" || unpacked === null) return null;
      value = unpacked as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    value = rawUpdate as Record<string, unknown>;
  }

  const type = value.updateDataType;
  const data = value.updateData;
  if (typeof type !== "number" || typeof data !== "object" || data === null) {
    return null;
  }
  const payload = data as Record<string, unknown>;

  const readBytes = (field: string): Uint8Array | null => {
    const direct = toBytes(payload[field]);
    if (direct) return direct;
    const reader = payload[`${field}Array`];
    if (typeof reader === "function") {
      try {
        const bytes = (reader as () => Uint8Array | null).call(payload);
        return bytes ? Uint8Array.from(bytes) : null;
      } catch {
        return null;
      }
    }
    return null;
  };

  if (type === UpdateDataType.DeltaUpdate) {
    const delta = readBytes("delta");
    return delta ? { kind: "delta", delta } : null;
  }
  if (type === UpdateDataType.StateUpdate) {
    const state = readBytes("state");
    return state ? { kind: "state", state } : null;
  }
  if (type === UpdateDataType.StateAndDeltaUpdate) {
    const state = readBytes("state");
    const delta = readBytes("delta");
    return state && delta ? { kind: "state-and-delta", state, delta } : null;
  }
  return null;
}

export function isNotFoundError(error: unknown): boolean {
  return /not[\s_-]*found|missing contract|contract.*missing/i.test(
    errorMessage(error),
  );
}

/**
 * Thin, reconnect-manual wrapper around FreenetWsApi for one owner board.
 * All failures are reported through callbacks and rejections; there is no
 * silent retry loop.
 */
export class NumberContract {
  private api: FreenetWsApi | null = null;
  private key: ContractKey | null = null;
  private codeHashBytes: Uint8Array;
  private status: ConnectionStatus = "idle";
  private connectPromise: Promise<void> | null = null;
  /**
   * Armed only while a GET is in flight; the node delivers NotFound via the
   * handler, not by rejecting the promise. One board per connection, so any
   * NotFound while armed is ours.
   */
  private missingListener: (() => void) | null = null;
  private openWaiter:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;

  constructor(
    private readonly codeHashBase58: string,
    private readonly wasmUrl: string,
    private readonly callbacks: NumberContractCallbacks = {},
  ) {
    this.codeHashBytes = decodeCodeHash(codeHashBase58);
  }

  get isConnected(): boolean {
    return this.api !== null && this.status === "connected";
  }

  get contractKey(): ContractKey | null {
    return this.key;
  }

  get contractKeyBase58(): string | null {
    return this.key?.encode() ?? null;
  }

  connect(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}/v1/contract/command`);

    this.setStatus("connecting");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.openWaiter) return;
        this.openWaiter = null;
        this.closeSocket();
        this.setStatus("error", "connection timed out");
        reject(new Error(`Timed out connecting to ${url.host}`));
      }, CONNECT_TIMEOUT_MS);

      this.openWaiter = { resolve, reject, timer };

      let api!: FreenetWsApi;
      const handler: ResponseHandler = {
        onOpen: () => {
          if (this.api !== api) return;
          this.settleOpen();
          this.setStatus("connected");
        },
        onClose: (code, reason) => {
          if (this.api !== api) return;
          this.failOpen(
            new Error(
              `Connection closed before it opened (${code}${reason ? `: ${reason}` : ""})`,
            ),
          );
          this.api = null;
          this.key = null;
          this.setStatus(
            "disconnected",
            reason ? `connection closed: ${reason}` : `connection closed (${code})`,
          );
        },
        onErr: (error: HostError) => {
          if (this.api !== api) return;
          this.callbacks.onError?.(`Freenet host error: ${error.cause}`, error);
        },
        onContractPut: () => {},
        onContractGet: (response) => {
          if (this.api !== api || !this.key) return;
          if (!this.isOurKey(response.key)) return;
          try {
            const state = decodeState(Uint8Array.from(response.state));
            this.callbacks.onState?.(state);
          } catch (error) {
            this.callbacks.onError?.(
              `Received invalid contract state: ${errorMessage(error)}`,
              error,
            );
          }
        },
        onContractUpdate: () => {},
        onContractUpdateNotification: (notification) => {
          if (this.api !== api || !this.key) return;
          if (!this.isOurKey(notification.key)) return;
          const update = extractUpdate(notification.update);
          if (!update) {
            this.callbacks.onError?.("Received an unsupported update notification");
            return;
          }
          this.callbacks.onNotification?.(update);
        },
        onContractNotFound: () => {
          if (this.api !== api) return;
          this.missingListener?.();
          this.callbacks.onNotFound?.();
        },
        onSubscribeResponse: (key, subscribed) => {
          if (this.api !== api || !this.key) return;
          if (!subscribed && this.isOurKey(key)) {
            this.callbacks.onError?.(
              "Node refused the contract subscription; live updates are unavailable.",
            );
          }
        },
        onDelegateResponse: (response) => {
          if (this.api !== api) return;
          this.callbacks.onDelegateResponse?.(response);
        },
      };

      try {
        api = new FreenetWsApi(url, handler, "");
        this.api = api;
      } catch (error) {
        clearTimeout(timer);
        this.openWaiter = null;
        this.api = null;
        this.setStatus("error", errorMessage(error));
        reject(
          new Error(`Could not open a WebSocket to ${url.host}: ${errorMessage(error)}`),
        );
      }
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private settleOpen(): void {
    if (!this.openWaiter) return;
    const waiter = this.openWaiter;
    this.openWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  private failOpen(error: Error): void {
    if (!this.openWaiter) return;
    const waiter = this.openWaiter;
    this.openWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.callbacks.onStatus?.(status, detail);
  }

  private isOurKey(key: ContractKey | null | undefined): boolean {
    if (!key || !this.key) return false;
    try {
      return key.encode() === this.key.encode();
    } catch {
      return false;
    }
  }

  async getState(timeoutMs: number = GET_TIMEOUT_MS): Promise<StateV2> {
    return this.getStateForKey(this.requireKey(), timeoutMs);
  }

  private async getStateForKey(
    key: ContractKey,
    timeoutMs: number,
  ): Promise<StateV2> {
    const api = this.requireApi();
    let signalMissing!: () => void;
    const missing = new Promise<never>((_, reject) => {
      signalMissing = () => reject(new ContractNotFoundError());
    });
    this.missingListener = signalMissing;
    try {
      const response = await withTimeout(
        Promise.race([api.get(new GetRequest(key, true)), missing]),
        timeoutMs,
        "Timed out fetching the contract state",
      );
      return decodeState(Uint8Array.from(response.state));
    } finally {
      this.missingListener = null;
    }
  }

  /**
   * GET the board; if the probe does not return state (genuine not-found *or* a
   * timeout — the node's not-found can surface as either), PUT the bundled WASM
   * with an empty initial state, then read again.
   *
   * PUT over an existing instance is safe: Freenet merges the incoming state
   * through the contract's `update_state`, and our empty state (every slot
   * `seq: 0`) loses every slot merge, so it is a no-op. The only cost of a
   * spurious PUT is re-sending the WASM.
   */
  async ensureState(
    parameters: Uint8Array,
    legacyContractCodeHashes: readonly string[] = [],
  ): Promise<StateV2> {
    if (parameters.length !== 32) {
      throw new Error(`contract parameters must be 32 bytes, got ${parameters.length}`);
    }
    this.key = deriveContractKey(this.codeHashBase58, parameters);

    let state: StateV2 | null = null;
    try {
      state = await this.getState(PROBE_TIMEOUT_MS);
    } catch {
      // A missing instance is expected on first use; fall through to PUT.
    }

    if (state === null) {
      const legacyState = await this.findLegacyState(
        parameters,
        legacyContractCodeHashes,
      );
      if (legacyState) {
        // Probe BEFORE writing the new key: PUT old state into the current
        // contract, whose validate_state re-checks every signature. If the
        // registry contains an incompatible version, surface the failure
        // instead of silently creating an empty board.
        await this.putState(parameters, legacyState);
      } else {
        await this.putState(parameters, emptyState());
      }
      state = await this.readAfterPut();
    }

    try {
      await this.subscribe();
    } catch (error) {
      // A refused subscription is not fatal: GET and UPDATE still work.
      this.callbacks.onError?.(
        `Could not subscribe for live updates: ${errorMessage(error)}`,
        error,
      );
    }

    return state;
  }

  /** Read back after a PUT, tolerating the node's short propagation delay. */
  private async readAfterPut(): Promise<StateV2> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.getState();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Timed out reading the contract state after publishing");
  }

  /** Probe old contract instances for state this version accepts. */
  private async findLegacyState(
    parameters: Uint8Array,
    legacyContractCodeHashes: readonly string[],
  ): Promise<StateV2 | null> {
    for (const codeHash of legacyContractCodeHashes) {
      try {
        const legacyKey = deriveContractKey(codeHash, parameters);
        const state = await this.getStateForKey(legacyKey, PROBE_TIMEOUT_MS);
        return state;
      } catch {
        // Not found, unreadable, or a timeout: try the next generation.
      }
    }
    return null;
  }

  private async putState(
    parameters: Uint8Array,
    state: StateV2,
  ): Promise<void> {
    const api = this.requireApi();
    let wasm: Uint8Array;
    try {
      const response = await fetch(this.wasmUrl);
      if (!response.ok) {
        throw new ContractBuildError(
          "ContractBuildMissing",
          `Contract build missing: ${this.wasmUrl} returned HTTP ${response.status}.`,
        );
      }
      wasm = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof ContractBuildError) throw error;
      throw new ContractBuildError(
        "ContractBuildMissing",
        `Contract build missing: could not load ${this.wasmUrl} (${errorMessage(error)}).`,
      );
    }

    if (wasm.length === 0) {
      throw new ContractBuildError(
        "ContractBuildMissing",
        `Contract build missing: ${this.wasmUrl} is empty.`,
      );
    }

    const actualHash = blake3(wasm);
    if (!equalBytes(actualHash, this.codeHashBytes)) {
      throw new ContractBuildError(
        "ContractBuildMismatch",
        `The bundled ${this.wasmUrl} does not match the build-time contract code hash. ` +
          "Rebuild the contract and copy the exact artifact, then rebuild the UI.",
      );
    }

    const request = buildNumberPutRequest(
      wasm,
      this.codeHashBytes,
      parameters,
      encodeState(state),
    );
    await withTimeout(api.put(request), PUT_TIMEOUT_MS, "Timed out publishing the contract");
  }

  async subscribe(): Promise<void> {
    const api = this.requireApi();
    const key = this.requireKey();
    try {
      await withTimeout(
        api.subscribe(new SubscribeRequest(key, [])),
        SUBSCRIBE_TIMEOUT_MS,
        "Timed out subscribing to the contract",
      );
    } catch (error) {
      // The node currently serializes SubscribeResponse as PutResponse
      // (freenet-stdlib; see reports/upstream-subscribe-response.md), so the
      // SDK never sees a confirmation and a refusal is indistinguishable from
      // a timeout. The subscription still becomes active — deltas arrive in a
      // second browser without a reload — so treat the timeout as
      // "unconfirmed", not failed.
      if (!/Timed out subscribing/i.test(errorMessage(error))) throw error;
      console.warn("[freenet] subscription unconfirmed; live deltas may still arrive");
    }
  }

  async updateDelta(delta: Delta): Promise<void> {
    const api = this.requireApi();
    const key = this.requireKey();
    const bytes = encodeDelta(delta);
    const update = new UpdateData(
      UpdateDataType.DeltaUpdate,
      new DeltaUpdate(Array.from(bytes)),
    );
    await withTimeout(
      api.update(new UpdateRequest(key, update)),
      UPDATE_TIMEOUT_MS,
      "Timed out sending the update",
    );
  }

  /** Used by DelegateClient — the public stdlib API has no delegate sender yet. */
  sendClientRequest(request: ClientRequestT): void {
    const api = this.requireApi();
    (api as unknown as { sendRequest: (request: ClientRequestT) => void }).sendRequest(
      request,
    );
  }

  close(): void {
    const api = this.api;
    this.api = null;
    this.key = null;
    this.failOpen(new Error("Connection closed"));
    if (api) {
      void api.disconnect(new DisconnectRequest("manual reconnect")).catch(() => {
        // The socket may already be gone; there is nothing useful to do.
      });
    }
    this.setStatus("disconnected");
  }

  private closeSocket(): void {
    const api = this.api;
    this.api = null;
    this.key = null;
    if (api) {
      void api.disconnect(new DisconnectRequest("connection timeout")).catch(() => {});
    }
  }

  private requireApi(): FreenetWsApi {
    if (!this.api) throw new Error("Not connected to a Freenet node");
    return this.api;
  }

  private requireKey(): ContractKey {
    if (!this.key) throw new Error("Contract key has not been derived yet");
    return this.key;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
