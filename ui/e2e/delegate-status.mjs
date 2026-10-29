import { readFileSync } from "node:fs";
import {
  ApplicationMessagesT,
  ClientRequestT,
  ClientRequestType,
  DelegateRequestT,
  DelegateRequestType,
  DelegateKeyT,
  InboundDelegateMsgT,
  InboundDelegateMsgType,
} from "@freenetorg/freenet-stdlib/client-request";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import { FreenetWsApi } from "@freenetorg/freenet-stdlib";

const port = Number(process.argv[2] ?? 7512);
const keyBytes = JSON.parse(readFileSync(new URL("../delegate_key_bytes.json", import.meta.url)));
const codeHashBytes = JSON.parse(readFileSync(new URL("../delegate_code_hash_bytes.json", import.meta.url)));
const paramsBytes = JSON.parse(readFileSync(new URL("../webapp_contract_id_bytes.json", import.meta.url)));

const handler = {
  onOpen: () => {
    const payload = new TextEncoder().encode(JSON.stringify({ cmd: "status" }));
    const inbound = new InboundDelegateMsgT(
      InboundDelegateMsgType.common_ApplicationMessage,
      new ApplicationMessageT(Array.from(payload), [], false),
    );
    const messages = new ApplicationMessagesT(
      new DelegateKeyT(keyBytes, codeHashBytes),
      paramsBytes,
      [inbound],
    );
    const request = new ClientRequestT(
      ClientRequestType.DelegateRequest,
      new DelegateRequestT(DelegateRequestType.ApplicationMessages, messages),
    );
    api.sendRequest(request);
  },
  onClose: (code, reason) => console.log("closed", code, reason),
  onErr: (error) => console.log("host error", error?.cause ?? error),
  onContractPut: () => {},
  onContractGet: () => {},
  onContractUpdate: () => {},
  onContractUpdateNotification: () => {},
  onContractNotFound: () => {},
  onDelegateResponse: (response) => {
    for (const outbound of response.values ?? []) {
      const type = typeof outbound.inboundType === "function" ? outbound.inboundType() : outbound.inboundType;
      if (type !== 1) continue; // common_ApplicationMessage
      const inbound = outbound.inbound;
      const bytes = inbound?.payload ?? inbound?.payloadArray?.() ?? [];
      if (!bytes?.length) continue;
      try {
        console.log(JSON.stringify(JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))), null, 2));
      } catch (error) {
        console.log("payload decode failed", error, bytes);
      }
    }
    setTimeout(() => process.exit(0), 300);
  },
};

const api = new FreenetWsApi(new URL(`ws://127.0.0.1:${port}/v1/contract/command`), handler, "");
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 20_000);
