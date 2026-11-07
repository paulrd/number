/**
 * Manual live smoke: read the region manifest from a running node.
 *
 *   node e2e/live-region.mjs ws://127.0.0.1:7509 <instance-base58> <manifest-code-hash-base58>
 *
 * Not part of CI: it needs a node and a published manifest. The same key
 * construction is what BlobReader/ContractSource use in the picker; the
 * dataset parser is covered by the committed golden in `fixtures/regions/`.
 */

import { ContractKey, FreenetWsApi, GetRequest } from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";

const [url, instanceBase58, codeBase58] = process.argv.slice(2);
if (!url || !instanceBase58 || !codeBase58) {
  console.error(
    "usage: node e2e/live-region.mjs <ws-url> <instance-base58> <manifest-code-hash-base58>",
  );
  process.exit(2);
}

const instance = bs58.decode(instanceBase58);
const code = bs58.decode(codeBase58);
if (instance.length !== 32 || code.length !== 32) {
  console.error("instance id and code hash must each decode to 32 bytes");
  process.exit(2);
}

const key = new ContractKey(instance, code);
let api;
let settled = false;

function finish(codeBound, message) {
  if (settled) return;
  settled = true;
  if (message) console[codeBound === 0 ? "log" : "error"](message);
  process.exit(codeBound);
}

const handler = {
  onOpen: () => {
    api.get(new GetRequest(key, false)).catch((error) => {
      finish(1, `GET rejected: ${String(error)}`);
    });
  },
  onContractGet: (response) => {
    const state = Uint8Array.from(response.state);
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const seq = state.length >= 12 ? Number(view.getBigUint64(0, true)) : 0;
    const payload = state.length >= 12 ? view.getUint32(8, true) : 0;
    finish(
      0,
      `manifest ${response.key.encode()}: ${state.length} bytes, seq ${seq}, payload ${payload}`,
    );
  },
  onContractNotFound: (instanceId) => {
    finish(1, `not found: ${bs58.encode(instanceId)}`);
  },
  onErr: (error) => finish(1, `host error: ${error.cause}`),
  onContractPut: () => {},
  onContractUpdate: () => {},
  onContractUpdateNotification: () => {},
  onDelegateResponse: () => {},
};

api = new FreenetWsApi(new URL(url), handler, "");
setTimeout(() => finish(2, "timed out reading the manifest"), 12_000);
