/**
 * Members-room client (`DESIGN-rooms.md`, P3b2).
 *
 * A room is a standalone parameterised contract:
 *
 *   parameters  = b"ZMR1" || owner_vk            // 36 bytes
 *   instance_id = BLAKE3(code_hash_bytes || parameters)
 *
 * The code hash is pinned at build time (`__ROOM_CODE_HASH__`); a room is never
 * derived from a fetched WASM. The client owns its own WebSocket connection to
 * the node's contract endpoint and talks to the room contract directly. The
 * delegate is only used for signing — it never sees or writes room state.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  type ContractKey,
  DeltaUpdate,
  DisconnectRequest,
  FreenetWsApi,
  GetRequest,
  UpdateData,
  UpdateDataType,
  UpdateRequest,
  type HostError,
  type ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import { type ContractKeyT } from "@freenetorg/freenet-stdlib/common";
import {
  buildNumberPutRequest,
  ContractNotFoundError,
  decodeCodeHash,
  deriveContractKey,
  deriveContractKeyTFromParts,
  deriveInstanceIdFromBytes,
  encodeBase58,
} from "./freenet";
import {
  encodeRoomDelta,
  encodeRoomState,
  latestMembership,
  parseRoomState,
  type RoomDeltaV1,
  type RoomMembershipV1,
  type RoomMessageV1,
  type RoomSecretV1,
  type RoomStateV1,
} from "./room-state";
import { bytesToHex, errorMessage, hexToBytes, isLowerHex, withTimeout } from "./util";

const CONNECT_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 12_000;
const PUT_TIMEOUT_MS = 35_000;
const UPDATE_TIMEOUT_MS = 30_000;

const ROOM_TAG = "ZMR1";
const ROOM_TAG_BYTES = new Uint8Array([0x5a, 0x4d, 0x52, 0x31]);
const ROOM_PARAMETERS_LEN = 36;
const ROOM_MAX_BODY_BYTES = 1024;
const SIGNATURE_HEX_LEN = 128;

export type RoomErrorCode =
  | "config"
  | "connection"
  | "read"
  | "write"
  | "sign"
  | "not-member"
  | "wasm";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

function wrapRoomError(code: RoomErrorCode, error: unknown): RoomError {
  if (error instanceof RoomError) return error;
  return new RoomError(code, errorMessage(error));
}

function roomCodeHashBase58(): string {
  return typeof __ROOM_CODE_HASH__ === "string" ? __ROOM_CODE_HASH__ : "";
}

function roomCodeHashBytes(): Uint8Array {
  const injected =
    typeof __ROOM_CODE_HASH_BYTES__ === "undefined"
      ? []
      : __ROOM_CODE_HASH_BYTES__;
  return Uint8Array.from(Array.isArray(injected) ? injected : []);
}

function roomWasmUrl(): string {
  return typeof __ROOM_WASM_URL__ === "string" && __ROOM_WASM_URL__
    ? __ROOM_WASM_URL__
    : "./number_room.wasm";
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Request shape sent to the delegate's `signRoomMembership`. */
export interface RoomSignMembershipRequest {
  roomId: string;
  owner: string;
  tag: string;
  seq: number;
  members: string[];
  secrets: RoomSecretV1[];
}

/** Request shape sent to the delegate's `signRoomMessage`. */
export interface RoomSignMessageRequest {
  roomId: string;
  owner: string;
  tag: string;
  epoch: number;
  time: number;
  body: string;
}

export interface RoomSigner {
  signRoomMembership(req: RoomSignMembershipRequest): Promise<string>;
  signRoomMessage(
    req: RoomSignMessageRequest,
  ): Promise<{ author: string; seq: number; sig: string }>;
}

/** b"ZMR1" || owner_vk (36 bytes). */
export function roomParameters(ownerId: string): Uint8Array {
  if (!isLowerHex(ownerId, 64)) {
    throw new RoomError(
      "config",
      "room owner must be 64 lowercase hex characters",
    );
  }
  const parameters = new Uint8Array(ROOM_PARAMETERS_LEN);
  parameters.set(ROOM_TAG_BYTES, 0);
  parameters.set(hexToBytes(ownerId), 4);
  return parameters;
}

/**
 * Derive the room's instance id and both key forms.
 *
 * `codeHashBase58` is injectable for tests; production always uses the
 * build-time pinned hash.
 */
export function roomInstanceId(
  ownerId: string,
  codeHashBase58: string = roomCodeHashBase58(),
): { id: string; key: ContractKey; keyT: ContractKeyT } {
  if (!codeHashBase58) {
    throw new RoomError(
      "config",
      "room code hash is missing; rebuild the UI through scripts/build.sh",
    );
  }
  let codeHashBytes: Uint8Array;
  try {
    codeHashBytes = decodeCodeHash(codeHashBase58);
  } catch (error) {
    throw new RoomError("config", errorMessage(error));
  }
  const parameters = roomParameters(ownerId);
  const instance = deriveInstanceIdFromBytes(codeHashBytes, parameters);
  return {
    id: instance.base58,
    key: deriveContractKey(codeHashBase58, parameters),
    keyT: deriveContractKeyTFromParts(codeHashBytes, parameters),
  };
}

/**
 * Low-level room connection. Split out so sequencing/signing logic can be
 * unit-tested without a node. The default implementation is
 * `FreenetRoomConnection`.
 */
export interface RoomConnection {
  get(parameters: Uint8Array): Promise<Uint8Array | null>;
  put(
    parameters: Uint8Array,
    wasm: Uint8Array,
    initialState: Uint8Array,
  ): Promise<void>;
  update(parameters: Uint8Array, delta: Uint8Array): Promise<void>;
  close(): void;
}

export interface RoomTransport {
  read(ownerId: string): Promise<RoomStateV1 | null>;
  updateMembership(ownerId: string, members: string[]): Promise<RoomStateV1>;
  sendMessage(ownerId: string, body: Uint8Array): Promise<RoomStateV1>;
}

export interface OnlineRoomTransportOptions {
  /** Injected transport for tests; production creates a WebSocket connection. */
  connection?: RoomConnection;
  /** Build-time pinned code hash; defaults to `__ROOM_CODE_HASH__`. */
  codeHashBase58?: string;
  /** Build-time pinned code hash bytes; defaults to `__ROOM_CODE_HASH_BYTES__`. */
  codeHashBytes?: Uint8Array;
  /** Bundled raw WASM URL; defaults to `__ROOM_WASM_URL__`. */
  wasmUrl?: string;
}

export class OnlineRoomTransport implements RoomTransport {
  private readonly codeHashBase58: string;
  private readonly codeHashBytes: Uint8Array;
  private readonly wasmUrl: string;
  private connection: RoomConnection | null;

  constructor(
    private readonly signer: RoomSigner,
    options: OnlineRoomTransportOptions = {},
  ) {
    this.codeHashBase58 = options.codeHashBase58 ?? roomCodeHashBase58();
    if (options.codeHashBytes) {
      this.codeHashBytes = Uint8Array.from(options.codeHashBytes);
    } else if (options.codeHashBase58) {
      try {
        this.codeHashBytes = decodeCodeHash(options.codeHashBase58);
      } catch (error) {
        throw new RoomError("config", errorMessage(error));
      }
    } else {
      this.codeHashBytes = roomCodeHashBytes();
    }
    // Tests and alternative deployments may supply bytes only; derive the
    // base58 form for the delegate request and instance id.
    this.codeHashBase58 =
      this.codeHashBase58 ||
      (this.codeHashBytes.length === 32 ? encodeBase58(this.codeHashBytes) : "");
    this.wasmUrl = options.wasmUrl ?? roomWasmUrl();
    this.connection = options.connection ?? null;
  }

  /**
   * Ensure the room instance exists. A missing instance is created by PUTting
   * the bundled raw WASM (verified against the pinned hash) with the static
   * empty v1 state.
   */
  async ensure(ownerId: string): Promise<void> {
    const existing = await this.read(ownerId);
    if (existing) return;

    if (this.codeHashBytes.length !== 32) {
      throw new RoomError(
        "wasm",
        "room code hash bytes are missing; rebuild the UI through scripts/build.sh",
      );
    }

    let wasm: Uint8Array;
    try {
      const response = await fetch(this.wasmUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      wasm = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new RoomError(
        "wasm",
        `could not load the room WASM from ${this.wasmUrl}: ${errorMessage(error)}`,
      );
    }

    if (wasm.length === 0) {
      throw new RoomError("wasm", `${this.wasmUrl} is empty`);
    }
    if (!equalBytes(blake3(wasm), this.codeHashBytes)) {
      throw new RoomError(
        "wasm",
        `the bundled ${this.wasmUrl} does not match the pinned room code hash; ` +
          "rebuild the room and the UI",
      );
    }

    const parameters = roomParameters(ownerId);
    const initialState = encodeRoomState({ v: 1, memberships: [], messages: [] });
    try {
      await this.connectionOrCreate().put(parameters, wasm, initialState);
    } catch (error) {
      throw wrapRoomError("write", error);
    }
  }

  async read(ownerId: string): Promise<RoomStateV1 | null> {
    const parameters = roomParameters(ownerId);
    let bytes: Uint8Array | null;
    try {
      bytes = await this.connectionOrCreate().get(parameters);
    } catch (error) {
      throw wrapRoomError("connection", error);
    }
    if (bytes === null) return null;
    try {
      return parseRoomState(bytes);
    } catch (error) {
      throw new RoomError("read", errorMessage(error));
    }
  }

  /**
   * Publish membership `latest.seq + 1`. The contract skips invalid deltas, so
   * an accepted UPDATE is not proof: read back and require the exact record.
   */
  async updateMembership(
    ownerId: string,
    members: string[],
  ): Promise<RoomStateV1> {
    const normalized = this.normalizeMembers(ownerId, members);
    await this.ensure(ownerId);
    const current = await this.read(ownerId);
    if (!current) {
      throw new RoomError("read", "room state is unavailable after ensure()");
    }

    const latest = latestMembership(current);
    const seq = (latest?.seq ?? 0) + 1;
    const roomId = this.instanceId(ownerId);

    let sig: string;
    try {
      sig = await this.signer.signRoomMembership({
        roomId,
        owner: ownerId,
        tag: ROOM_TAG,
        seq,
        members: normalized,
        secrets: [],
      });
    } catch (error) {
      throw wrapRoomError("sign", error);
    }
    if (!isLowerHex(sig, SIGNATURE_HEX_LEN)) {
      throw new RoomError(
        "sign",
        "delegate returned a malformed room membership signature",
      );
    }

    const record: RoomMembershipV1 = {
      seq,
      members: normalized,
      secrets: [],
      sig,
    };
    await this.sendDelta(ownerId, { v: 1, memberships: [record] });

    const after = await this.read(ownerId);
    if (!after) {
      throw new RoomError("read", "room state is unavailable after the update");
    }
    const applied = after.memberships.find((item) => item.seq === seq);
    if (!applied || applied.sig !== sig) {
      throw new RoomError(
        "write",
        `room membership seq ${seq} was not accepted by the contract`,
      );
    }
    return after;
  }

  /** Publish one message at the latest membership epoch. */
  async sendMessage(
    ownerId: string,
    body: Uint8Array,
  ): Promise<RoomStateV1> {
    if (body.length < 1 || body.length > ROOM_MAX_BODY_BYTES) {
      throw new RoomError(
        "write",
        `room message body must be 1..${ROOM_MAX_BODY_BYTES} bytes`,
      );
    }
    await this.ensure(ownerId);
    const current = await this.read(ownerId);
    if (!current) {
      throw new RoomError("read", "room state is unavailable after ensure()");
    }
    const latest = latestMembership(current);
    if (!latest || !latest.members.includes(ownerId)) {
      throw new RoomError(
        "not-member",
        "the room owner is not a member of the latest room epoch",
      );
    }

    const epoch = latest.seq;
    const time = Date.now();
    const bodyHex = bytesToHex(body);
    const roomId = this.instanceId(ownerId);

    let signed: { author: string; seq: number; sig: string };
    try {
      signed = await this.signer.signRoomMessage({
        roomId,
        owner: ownerId,
        tag: ROOM_TAG,
        epoch,
        time,
        body: bodyHex,
      });
    } catch (error) {
      throw wrapRoomError("sign", error);
    }
    if (signed.author !== ownerId) {
      throw new RoomError(
        "sign",
        `delegate signed the room message as ${signed.author}, not ${ownerId}`,
      );
    }
    if (!Number.isSafeInteger(signed.seq) || signed.seq <= 0) {
      throw new RoomError("sign", "delegate returned an invalid room message seq");
    }
    if (!isLowerHex(signed.sig, SIGNATURE_HEX_LEN)) {
      throw new RoomError(
        "sign",
        "delegate returned a malformed room message signature",
      );
    }

    const message: RoomMessageV1 = {
      author: signed.author,
      epoch,
      seq: signed.seq,
      time,
      body: bodyHex,
      sig: signed.sig,
    };
    await this.sendDelta(ownerId, { v: 1, messages: [message] });

    const after = await this.read(ownerId);
    if (!after) {
      throw new RoomError("read", "room state is unavailable after the message");
    }
    return after;
  }

  close(): void {
    this.connection?.close();
  }

  private async sendDelta(
    ownerId: string,
    delta: RoomDeltaV1,
  ): Promise<void> {
    const parameters = roomParameters(ownerId);
    try {
      await this.connectionOrCreate().update(parameters, encodeRoomDelta(delta));
    } catch (error) {
      throw wrapRoomError("write", error);
    }
  }

  private normalizeMembers(ownerId: string, members: string[]): string[] {
    if (!Array.isArray(members)) {
      throw new RoomError("write", "room members must be an array");
    }
    const unique = [...new Set(members)];
    unique.sort();
    if (unique.length < 1 || unique.length > 9) {
      throw new RoomError("write", "room membership must contain 1..9 members");
    }
    for (const member of unique) {
      if (!isLowerHex(member, 64)) {
        throw new RoomError(
          "write",
          "room members must be 64 lowercase hex characters",
        );
      }
    }
    if (!unique.includes(ownerId)) {
      throw new RoomError(
        "not-member",
        "room membership must include the room owner",
      );
    }
    return unique;
  }

  /**
   * `ensure()` and every write are owner-scoped. Kept separate so the
   * parameter-free connection can be shared across calls.
   */
  private instanceId(ownerId: string): string {
    return roomInstanceId(ownerId, this.codeHashBase58).id;
  }

  private connectionOrCreate(): RoomConnection {
    if (!this.connection) {
      if (!this.codeHashBase58) {
        throw new RoomError(
          "config",
          "room code hash is missing; rebuild the UI through scripts/build.sh",
        );
      }
      this.connection = new FreenetRoomConnection(this.codeHashBase58);
    }
    return this.connection;
  }
}

/**
 * Default connection: one WebSocket, one room key. Mirrors the GET/UPDATE/PUT
 * plumbing of `NumberContract` but with 36-byte parameters and a single-key
 * filter.
 */
export class FreenetRoomConnection implements RoomConnection {
  private api: FreenetWsApi | null = null;
  private connectPromise: Promise<void> | null = null;
  private missingListener: (() => void) | null = null;
  private openWaiter:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private readonly codeHashBytes: Uint8Array;

  constructor(private readonly codeHashBase58: string) {
    this.codeHashBytes = decodeCodeHash(codeHashBase58);
  }

  private connect(): Promise<void> {
    if (this.api !== null) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}/v1/contract/command`);

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.openWaiter) return;
        this.openWaiter = null;
        this.closeSocket();
        reject(new Error(`Timed out connecting to ${url.host}`));
      }, CONNECT_TIMEOUT_MS);

      this.openWaiter = { resolve, reject, timer };

      let api!: FreenetWsApi;
      const handler: ResponseHandler = {
        onOpen: () => {
          if (this.api !== api) return;
          this.settleOpen();
        },
        onClose: (code, reason) => {
          if (this.api !== api) return;
          this.api = null;
          this.failOpen(
            new Error(
              `Connection closed before it opened (${code}${reason ? `: ${reason}` : ""})`,
            ),
          );
        },
        onErr: (_error: HostError) => {},
        onContractPut: () => {},
        onContractGet: () => {},
        onContractUpdate: () => {},
        onContractUpdateNotification: () => {},
        onContractNotFound: () => {
          if (this.api !== api) return;
          this.missingListener?.();
        },
        onSubscribeResponse: () => {},
        onDelegateResponse: () => {},
      };

      try {
        api = new FreenetWsApi(url, handler, "");
        this.api = api;
      } catch (error) {
        clearTimeout(timer);
        this.openWaiter = null;
        this.api = null;
        reject(
          new Error(
            `Could not open a WebSocket to ${url.host}: ${errorMessage(error)}`,
          ),
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

  async get(parameters: Uint8Array): Promise<Uint8Array | null> {
    const key = deriveContractKey(this.codeHashBase58, parameters);
    await this.connect();
    const api = this.requireApi();

    let signalMissing!: () => void;
    const missing = new Promise<never>((_, reject) => {
      signalMissing = () => reject(new ContractNotFoundError());
    });
    this.missingListener = signalMissing;
    try {
      const response = await withTimeout(
        Promise.race([api.get(new GetRequest(key, true)), missing]),
        GET_TIMEOUT_MS,
        "Timed out fetching the room state",
      );
      // Single-key filter: this connection only serves one room.
      const actualKey = response.key?.encode?.();
      if (actualKey && actualKey !== key.encode()) {
        throw new Error(
          `received state for room ${actualKey}, expected ${key.encode()}`,
        );
      }
      return Uint8Array.from(response.state);
    } catch (error) {
      if (error instanceof ContractNotFoundError) return null;
      throw error;
    } finally {
      this.missingListener = null;
    }
  }

  async put(
    parameters: Uint8Array,
    wasm: Uint8Array,
    initialState: Uint8Array,
  ): Promise<void> {
    await this.connect();
    const api = this.requireApi();
    const request = buildNumberPutRequest(
      wasm,
      this.codeHashBytes,
      parameters,
      initialState,
    );
    await withTimeout(
      api.put(request),
      PUT_TIMEOUT_MS,
      "Timed out publishing the room",
    );
  }

  async update(parameters: Uint8Array, delta: Uint8Array): Promise<void> {
    const key = deriveContractKey(this.codeHashBase58, parameters);
    await this.connect();
    const api = this.requireApi();
    const update = new UpdateData(
      UpdateDataType.DeltaUpdate,
      new DeltaUpdate(Array.from(delta)),
    );
    await withTimeout(
      api.update(new UpdateRequest(key, update)),
      UPDATE_TIMEOUT_MS,
      "Timed out sending the room update",
    );
  }

  close(): void {
    const api = this.api;
    this.api = null;
    this.failOpen(new Error("Connection closed"));
    if (api) {
      void api.disconnect(new DisconnectRequest("room client closed")).catch(() => {
        // The socket may already be gone.
      });
    }
  }

  private closeSocket(): void {
    const api = this.api;
    this.api = null;
    if (api) {
      void api.disconnect(new DisconnectRequest("connection timeout")).catch(() => {});
    }
  }

  private requireApi(): FreenetWsApi {
    if (!this.api) throw new Error("Not connected to a Freenet node");
    return this.api;
  }
}
