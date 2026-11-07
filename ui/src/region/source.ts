/**
 * Region data sources: the live manifest/shard contracts, and an in-memory
 * fixture for tests and offline mode.
 *
 * The reader is deliberately separate from NumberContract: the zone contract is
 * single-key and decodes zone state, while this one serves arbitrary
 * content-addressed blobs and must multiplex several GETs over one socket.
 */

import {
  ContractKey,
  DisconnectRequest,
  FreenetWsApi,
  GetRequest,
  type HostError,
  type ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";
import { deriveContractKey, encodeBase58 } from "../freenet";
import { bytesToHex, errorMessage } from "../util";

const CONNECT_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 12_000;
const MAX_CONCURRENT = 3;

export class RegionMissingError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`region contract ${id} was not found`);
    this.name = "RegionMissingError";
    this.id = id;
  }
}

/** One contract GET, multiplexed by instance id. */
export class BlobReader {
  private api: FreenetWsApi | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (bytes: Uint8Array) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private slots = MAX_CONCURRENT;
  private waiters: Array<() => void> = [];

  constructor(private readonly url?: URL) {}

  async get(key: ContractKey, timeoutMs: number = GET_TIMEOUT_MS): Promise<Uint8Array> {
    await this.acquire();
    try {
      await this.connect();
      const id = key.encode();
      if (this.pending.has(id)) {
        throw new Error(`a GET for ${id} is already in flight`);
      }
      return await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`GET ${id} timed out`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        try {
          void this.requireApi()
            .get(new GetRequest(key, false))
            .catch((error: unknown) => this.rejectOne(id, error));
        } catch (error) {
          this.rejectOne(id, error);
        }
      });
    } finally {
      this.release();
    }
  }

  disconnect(): void {
    const api = this.api;
    this.api = null;
    this.rejectAll(new Error("reader disconnected"));
    if (api) {
      void api.disconnect(new DisconnectRequest("reader disconnected")).catch(() => {});
    }
  }

  private requireApi(): FreenetWsApi {
    if (!this.api) throw new Error("region reader is not connected");
    return this.api;
  }

  private connect(): Promise<void> {
    if (this.api) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const url = this.url ?? defaultNodeUrl();
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        this.connectPromise = null;
        reject(new Error("region reader connection timed out"));
      }, CONNECT_TIMEOUT_MS);

      const handler: ResponseHandler = {
        onOpen: () => {
          opened = true;
          clearTimeout(timer);
          resolve();
        },
        onClose: (code, reason) => {
          this.api = null;
          this.connectPromise = null;
          const message = `region reader closed (${code}${reason ? `: ${reason}` : ""})`;
          if (!opened) {
            clearTimeout(timer);
            reject(new Error(message));
          }
          this.rejectAll(new Error(message));
        },
        onErr: (error: HostError) => {
          this.rejectAll(new Error(`region reader host error: ${error.cause}`));
        },
        onContractPut: () => {},
        onContractGet: (response) => {
          const id = response.key.encode();
          const waiting = this.pending.get(id);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          this.pending.delete(id);
          waiting.resolve(Uint8Array.from(response.state));
        },
        onContractUpdate: () => {},
        onContractUpdateNotification: () => {},
        onContractNotFound: (instance) => {
          const id = instance.length > 0 ? bs58.encode(instance) : "";
          this.rejectOne(id, new RegionMissingError(id));
        },
        onDelegateResponse: () => {},
      };

      try {
        this.api = new FreenetWsApi(url, handler, "");
      } catch (error) {
        clearTimeout(timer);
        this.connectPromise = null;
        reject(
          new Error(`could not open the region reader: ${errorMessage(error)}`),
        );
      }
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private rejectOne(id: string, error: unknown): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectAll(error: Error): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.reject(error);
    }
  }

  private acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.slots += 1;
  }
}

function defaultNodeUrl(): URL {
  if (typeof location === "undefined") {
    throw new Error("no Freenet node URL outside a browser");
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`${protocol}//${location.host}/v1/contract/command`);
}

export interface RegionSource {
  /** The signed manifest state envelope. */
  getManifest(): Promise<Uint8Array>;
  /** The shard bytes for the entry's params (`RGB1 || content_hash`). */
  getShard(codeHash: Uint8Array, parameters: Uint8Array): Promise<Uint8Array>;
}

export class ContractSource implements RegionSource {
  constructor(
    private readonly reader: BlobReader,
    private readonly manifestKey: ContractKey,
  ) {}

  getManifest(): Promise<Uint8Array> {
    return this.reader.get(this.manifestKey);
  }

  getShard(codeHash: Uint8Array, parameters: Uint8Array): Promise<Uint8Array> {
    return this.reader.get(deriveContractKey(encodeBase58(codeHash), parameters));
  }
}

/** Build a reader key for an instance id + raw code hash, without parameters. */
export function contractKeyFromInstance(
  instanceBase58: string,
  codeHashBase58: string,
): ContractKey {
  const instance = Uint8Array.from(bs58.decode(instanceBase58));
  if (instance.length !== 32) {
    throw new Error("manifest instance id must be 32 bytes");
  }
  const code = Uint8Array.from(bs58.decode(codeHashBase58));
  if (code.length !== 32) {
    throw new Error("manifest code hash must be 32 bytes");
  }
  return new ContractKey(
    instance as unknown as ConstructorParameters<typeof ContractKey>[0],
    code,
  );
}

export class FixtureSource implements RegionSource {
  private calls = 0;

  constructor(
    private readonly manifestState: Uint8Array,
    private readonly shards: Map<string, Uint8Array>,
  ) {}

  get getShardCalls(): number {
    return this.calls;
  }

  async getManifest(): Promise<Uint8Array> {
    return this.manifestState;
  }

  async getShard(
    _codeHash: Uint8Array,
    parameters: Uint8Array,
  ): Promise<Uint8Array> {
    this.calls += 1;
    const hash = parameters.subarray(4);
    const bytes = this.shards.get(bytesToHex(hash));
    if (!bytes) {
      throw new RegionMissingError(bytesToHex(hash));
    }
    return bytes;
  }
}
