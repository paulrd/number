/**
 * Delegate request/response transport.
 *
 * The number-delegate speaks JSON in `ApplicationMessage.payload` (DESIGN §7).
 * stdlib 0.4.0 still has no public delegate-send API, so we build the flatbuffer
 * request here and hand it to FreenetWsApi's private `sendRequest` through a
 * narrow callback supplied by NumberContract. Responses arrive through the
 * regular ResponseHandler.
 */

import {
  DelegateRequest,
  type DelegateResponse,
} from "@freenetorg/freenet-stdlib";
import { OutboundDelegateMsgType } from "@freenetorg/freenet-stdlib/host-response";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  ApplicationMessagesT,
  ClientRequestT,
  ClientRequestType,
  DelegateKeyT,
  DelegateRequestType,
  InboundDelegateMsgT,
  InboundDelegateMsgType,
  type ClientRequestT as ClientRequestTable,
} from "@freenetorg/freenet-stdlib/client-request";
import {
  validateEntry,
  type Entry,
} from "./state";
import { errorMessage, isLowerHex } from "./util";

export type DelegateErrorCode =
  | "Missing"
  | "Config"
  | "Timeout"
  | "Unavailable"
  | "Protocol"
  | "Rejected";

export class DelegateError extends Error {
  readonly code: DelegateErrorCode;

  constructor(code: DelegateErrorCode, message: string) {
    super(message);
    this.name = "DelegateError";
    this.code = code;
  }
}

export const MISSING_DELEGATE_MESSAGE =
  "The number-delegate is not registered with this Freenet node. " +
  "Publish the delegate, then rebuild the UI with its key bytes and code hash.";

export function isMissingDelegateError(error: unknown): error is DelegateError {
  return error instanceof DelegateError && error.code === "Missing";
}

export interface DelegateIdentity {
  /** 32-byte Ed25519 verifying key as 64 lowercase hex characters. */
  pubkey: string;
  /** Per-slot next sequence values, 8 entries, each >= 1. */
  nextSeq: number[];
}

export interface DelegateStatus {
  hasSeed: boolean;
  /** Present only when `hasSeed` is true. */
  identity: DelegateIdentity | null;
}

export interface ExportedSecrets {
  /** 32-byte Ed25519 seed as 64 lowercase hex characters. */
  seed: string;
  nextSeq: number[];
}

type ResponseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ResponseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
    return Uint8Array.from(value);
  }
  return null;
}

/** Extract JSON payloads from the outbound application messages in a response. */
export function parseDelegatePayloads(response: DelegateResponse): unknown[] {
  const values = (response as unknown as { values?: unknown }).values;
  if (!Array.isArray(values)) return [];

  const payloads: unknown[] = [];
  for (const outbound of values) {
    if (!isRecord(outbound)) continue;

    const rawType = outbound.inboundType;
    const type =
      typeof rawType === "function"
        ? (rawType as () => number).call(outbound)
        : rawType;
    if (type !== OutboundDelegateMsgType.common_ApplicationMessage) continue;

    const rawInbound = outbound.inbound;
    const inbound =
      typeof rawInbound === "function"
        ? (rawInbound as () => unknown).call(outbound)
        : rawInbound;
    if (!isRecord(inbound)) continue;

    const payload = toBytes(inbound.payload);
    if (!payload || payload.length === 0) continue;
    try {
      payloads.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
    } catch (error) {
      console.warn("[delegate] could not parse application payload:", errorMessage(error));
    }
  }
  return payloads;
}

function classifyDelegateFailure(message: string): DelegateError {
  if (
    /delegate/i.test(message) &&
    /not[\s_-]*found|not[\s_-]*registered|missing|unknown|no such|unavailable/i.test(
      message,
    )
  ) {
    return new DelegateError(
      "Missing",
      `${MISSING_DELEGATE_MESSAGE} (node said: ${message})`,
    );
  }
  return new DelegateError("Rejected", `Delegate request failed: ${message}`);
}

interface PendingRequest {
  kind: "identity" | "sign" | "status" | "export" | "import";
  resolve: (payload: ResponseRecord) => void;
  reject: (error: DelegateError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DelegateClient {
  private readonly keyBytes: number[];
  private readonly codeHashBytes: number[];
  private readonly paramsBytes: number[];
  private pending: PendingRequest[] = [];
  private readonly configError: DelegateError | null;

  constructor(
    private readonly send: (request: ClientRequestTable) => void,
    keyBytes: number[],
    codeHashBytes: number[],
    paramsBytes: number[],
  ) {
    this.keyBytes = [...keyBytes];
    this.codeHashBytes = [...codeHashBytes];
    this.paramsBytes = [...paramsBytes];

    if (
      this.keyBytes.length !== 32 ||
      this.codeHashBytes.length !== 32 ||
      this.paramsBytes.length !== 32
    ) {
      this.configError = new DelegateError(
        "Config",
        "Delegate build configuration is missing or invalid: expected 32-byte " +
          "delegate key, 32-byte delegate code hash, and 32-byte webapp id " +
          "parameters. Rebuild the UI after publishing the delegate.",
      );
    } else {
      this.configError = null;
    }
  }

  identity(timeoutMs = 12_000): Promise<DelegateIdentity> {
    return this.request("identity", { cmd: "identity" }, timeoutMs).then(
      (payload) => this.parseIdentity(payload),
    );
  }

  /** Report whether a seed exists without creating one. */
  status(timeoutMs = 5_000): Promise<DelegateStatus> {
    return this.request("status", { cmd: "status" }, timeoutMs).then((payload) =>
      this.parseStatus(payload),
    );
  }

  /** Ask a predecessor delegate for its seed and sequence counters. */
  exportSecrets(timeoutMs = 5_000): Promise<ExportedSecrets> {
    return this.request("export", { cmd: "export" }, timeoutMs).then((payload) =>
      this.parseExport(payload),
    );
  }

  /** Restore a predecessor's seed into this fresh delegate. */
  async importSecrets(
    seed: string,
    nextSeq: number[],
    timeoutMs = 5_000,
  ): Promise<void> {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new DelegateError(
        "Protocol",
        "Refusing to import a seed that is not 32 bytes of hex.",
      );
    }
    this.validateNextSeq(nextSeq);
    await this.request(
      "import",
      { cmd: "import", seed: seed.toLowerCase(), nextSeq },
      timeoutMs,
    );
  }

  async sign(
    slot: number,
    seq: number,
    entry: Entry | null,
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
      throw new DelegateError("Protocol", `slot must be in 0..7, got ${slot}`);
    }
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    const validatedEntry = entry === null ? null : validateEntry(entry);

    const payload = await this.request(
      "sign",
      { cmd: "sign", slot, seq, entry: validatedEntry },
      timeoutMs,
    );
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "sign was rejected",
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return sig;
  }

  /** Feed an outbound DelegateResponse into the waiting request queue. */
  handleResponse(response: DelegateResponse): void {
    const payloads = parseDelegatePayloads(response);
    if (this.pending.length === 0) return;

    if (payloads.length === 0) {
      this.rejectAll(
        new DelegateError(
          "Missing",
          `${MISSING_DELEGATE_MESSAGE} The delegate returned no application message.`,
        ),
      );
      return;
    }

    for (const payload of payloads) {
      if (!isRecord(payload)) continue;

      let index = -1;
      if (payload.ok === false) {
        index = 0; // error responses carry no command discriminator
      } else if (typeof payload.hasSeed === "boolean") {
        index = this.pending.findIndex((pending) => pending.kind === "status");
      } else if (typeof payload.seed === "string") {
        index = this.pending.findIndex((pending) => pending.kind === "export");
      } else if (typeof payload.pubkey === "string") {
        index = this.pending.findIndex((pending) => pending.kind === "identity");
      } else if (typeof payload.sig === "string") {
        index = this.pending.findIndex((pending) => pending.kind === "sign");
      } else if (payload.ok === true) {
        index = this.pending.findIndex((pending) => pending.kind === "import");
      }
      if (index === -1 && isRecord(payload) && typeof payload.error === "string") {
        index = 0;
      }
      if (index < 0) continue;

      const [pending] = this.pending.splice(index, 1);
      clearTimeout(pending.timer);

      if (payload.ok === false) {
        pending.reject(
          classifyDelegateFailure(
            typeof payload.error === "string" ? payload.error : "delegate rejected the request",
          ),
        );
      } else {
        pending.resolve(payload);
      }
    }
  }

  /** Freenet routed a HostError to us; reject anything waiting. */
  handleHostError(message: string): void {
    this.rejectAll(classifyDelegateFailure(message));
  }

  /** Connection closed / manual reconnect. */
  failAll(message = "Connection to the Freenet node was closed."): void {
    this.rejectAll(new DelegateError("Unavailable", message));
  }

  private request(
    kind: PendingRequest["kind"],
    message: object,
    timeoutMs: number,
  ): Promise<ResponseRecord> {
    if (this.configError) return Promise.reject(this.configError);

    return new Promise<ResponseRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index !== -1) this.pending.splice(index, 1);
        reject(
          new DelegateError(
            "Timeout",
            `The delegate did not answer the ${kind} request within ${Math.round(
              timeoutMs / 1000,
            )}s.`,
          ),
        );
      }, timeoutMs);

      this.pending.push({ kind, resolve, reject, timer });

      try {
        this.send(this.buildRequest(message));
      } catch (error) {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index !== -1) this.pending.splice(index, 1);
        clearTimeout(timer);
        reject(
          new DelegateError(
            "Unavailable",
            `Could not send the delegate request: ${errorMessage(error)}`,
          ),
        );
      }
    });
  }

  private buildRequest(message: object): ClientRequestTable {
    const payload = Array.from(
      new TextEncoder().encode(JSON.stringify(message)),
    );
    const appMessage = new ApplicationMessageT(payload, [], false);
    const inbound = new InboundDelegateMsgT(
      InboundDelegateMsgType.common_ApplicationMessage,
      appMessage,
    );
    const delegateKey = new DelegateKeyT(this.keyBytes, this.codeHashBytes);
    // The node checks BLAKE3(code_hash || params) against the key on every
    // request. The delegate was published with the webapp id as its params,
    // so omitting them here makes the node refuse the request.
    const appMessages = new ApplicationMessagesT(delegateKey, this.paramsBytes, [inbound]);
    const delegateRequest = new DelegateRequest(
      DelegateRequestType.ApplicationMessages,
      appMessages,
    );
    return new ClientRequestT(ClientRequestType.DelegateRequest, delegateRequest);
  }

  private parseIdentity(payload: ResponseRecord): DelegateIdentity {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "identity was rejected",
      );
    }

    const pubkey = payload.pubkey;
    if (typeof pubkey !== "string" || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
      throw new DelegateError(
        "Protocol",
        "Delegate identity response has a malformed pubkey (expected 64 hex characters).",
      );
    }

    return {
      pubkey: pubkey.toLowerCase(),
      nextSeq: this.validateNextSeq(payload.nextSeq),
    };
  }

  private parseStatus(payload: ResponseRecord): DelegateStatus {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "status was rejected",
      );
    }
    if (typeof payload.hasSeed !== "boolean") {
      throw new DelegateError(
        "Protocol",
        "Delegate status response is missing a boolean hasSeed.",
      );
    }
    if (!payload.hasSeed) return { hasSeed: false, identity: null };

    return {
      hasSeed: true,
      identity: this.parseIdentity(payload),
    };
  }

  private parseExport(payload: ResponseRecord): ExportedSecrets {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "export was rejected",
      );
    }
    const seed = payload.seed;
    if (typeof seed !== "string" || !/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new DelegateError(
        "Protocol",
        "Delegate export response has a malformed seed (expected 64 hex characters).",
      );
    }

    return {
      seed: seed.toLowerCase(),
      nextSeq: this.validateNextSeq(payload.nextSeq),
    };
  }

  private validateNextSeq(value: unknown): number[] {
    if (
      !Array.isArray(value) ||
      value.length !== 8 ||
      value.some(
        (entry) =>
          typeof entry !== "number" ||
          !Number.isSafeInteger(entry) ||
          entry < 1,
      )
    ) {
      throw new DelegateError(
        "Protocol",
        "Delegate response has malformed nextSeq (expected 8 positive integers).",
      );
    }
    return [...(value as number[])];
  }

  private rejectAll(error: DelegateError): void {
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
}
