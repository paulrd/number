import bs58mod from "bs58";
import { blake3 } from "@noble/hashes/blake3";
import { readFileSync } from "node:fs";
import { ContractKey, GetRequest, FreenetWsApi } from "@freenetorg/freenet-stdlib";

/**
 * Read-only link audit of the four live boards.
 *
 * Builds the parent graph (the one that defines addresses and payment routes)
 * and the slot-contact graph (including stale references), then reports any
 * cycle in either. Run from ui/: node e2e/links.mjs
 */
const bs58 = bs58mod.default ?? bs58mod;
const CODE_HASH = Uint8Array.from(JSON.parse(readFileSync(new URL("../contract_code_hash_bytes.json", import.meta.url))));
const NODES = [
  { name: "A", port: 7511, owner: "ea145d06e9f8b24abaa0b6917762f70535361f5994324a989a8fb2a155534c6b" },
  { name: "B", port: 7512, owner: "4e7aa9bd5313a1edce3209d7d81290f1e896c026ac8e089b6023ed87a171d8cc" },
  { name: "C", port: 7513, owner: "06e6974706312c3fbbe12baa0bf01eebd14371fe7d421b379dd7c2e93e91213d" },
  { name: "D", port: 7509, owner: "3f8411470c801051120a0ff14b5ab571c5660df42c17bc72677c37f2505c27b0" },
];
const byOwner = new Map(NODES.map((n) => [n.owner, n.name]));
const tag = (owner) => byOwner.get(owner) ?? (owner ? owner.slice(0, 8) : "root");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instanceOf(ownerHex) {
  const owner = Uint8Array.from(Buffer.from(ownerHex, "hex"));
  return blake3(new Uint8Array([...CODE_HASH, ...owner]));
}

async function readBoard(port, ownerHex) {
  const instance = instanceOf(ownerHex);
  const key = new ContractKey(instance, CODE_HASH);
  let state = null;
  const api = new FreenetWsApi(
    new URL(`ws://127.0.0.1:${port}/v1/contract/command`),
    {
      onOpen: async () => {
        try {
          const response = await api.get(new GetRequest(key, true));
          state = JSON.parse(new TextDecoder().decode(Uint8Array.from(response.state)));
        } catch (error) {
          console.log(`[${port}] get failed`, error?.message ?? error);
        }
      },
      onClose: () => {},
      onErr: (e) => console.log(`[${port}] host error`, e?.cause ?? e),
      onContractPut: () => {},
      onContractGet: () => {},
      onContractUpdate: () => {},
      onContractUpdateNotification: () => {},
      onContractNotFound: () => console.log(`[${port}] board not found`),
      onDelegateResponse: () => {},
    },
    "",
  );
  for (let i = 0; i < 100 && state === null; i += 1) await sleep(100);
  try { api.ws?.close?.(); } catch {}
  return state;
}

const boards = new Map();
for (const node of NODES) {
  const state = await readBoard(node.port, node.owner);
  if (state === null) {
    console.log(`${node.name}: unreadable`);
    continue;
  }
  boards.set(node.owner, { name: node.name, state });
}

console.log("== boards");
for (const node of NODES) {
  const board = boards.get(node.owner);
  if (!board) continue;
  const parent = board.state.parent?.userId ?? null;
  const slots = board.state.slots
    .map((slot, index) =>
      slot.entry
        ? `slot ${index} → ${tag(slot.entry.contact)} ${(Number(slot.entry.value) / 100).toFixed(2)}`
        : null,
    )
    .filter(Boolean);
  console.log(
    `${node.name} (${node.owner.slice(0, 8)}): parent ${parent ? tag(parent) : "root"}; ${slots.join(", ") || "no slots"}`,
  );
}

// Parent graph: board -> parent. This is what addresses and payment routes use.
console.log("== parent tree");
const parentOf = new Map();
for (const [owner, board] of boards) {
  const parent = board.state.parent?.userId ?? null;
  if (parent) parentOf.set(owner, parent);
}
function findParentCycle(start) {
  const index = new Map();
  const path = [];
  let node = start;
  while (parentOf.has(node)) {
    if (index.has(node)) return path.slice(index.get(node)).map((id) => tag(id));
    index.set(node, path.length);
    path.push(node);
    node = parentOf.get(node);
  }
  return null;
}
let parentCycle = null;
for (const owner of boards.keys()) {
  const cycle = findParentCycle(owner);
  if (cycle) { parentCycle = cycle; break; }
}
console.log(parentCycle ? `CYCLE: ${[...parentCycle, parentCycle[0]].join(" → ")}` : "acyclic");

// Slot graph: board -> each slot contact (including stale ones).
console.log("== slot edges");
const slotEdges = [];
const slotOf = new Map();
for (const [owner, board] of boards) {
  const edges = [];
  board.state.slots.forEach((slot, index) => {
    if (!slot.entry) return;
    const contact = slot.entry.contact;
    edges.push({ index, contact });
    slotEdges.push({ from: owner, to: contact, index });
  });
  slotOf.set(owner, edges);
}
for (const edge of slotEdges) {
  const child = boards.get(edge.to);
  const live = child ? child.state.parent?.userId === edge.from : false;
  console.log(`${tag(edge.from)} slot ${edge.index} → ${tag(edge.to)} (${live ? "live" : "stale"})`);
}

function findSlotCycle() {
  const state = new Map();
  const stack = [];
  const walk = (node) => {
    const mark = state.get(node);
    if (mark === 1) return stack.slice(stack.indexOf(node));
    if (mark === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const edge of slotOf.get(node) ?? []) {
      if (!boards.has(edge.contact)) continue;
      const found = walk(edge.contact);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const owner of boards.keys()) {
    const found = walk(owner);
    if (found) return found;
  }
  return null;
}
const cycle = findSlotCycle();
console.log("== slot graph");
console.log(
  cycle
    ? `CYCLE (stale slot references, not a parent/route cycle): ${[...cycle, cycle[0]].map(tag).join(" → ")}`
    : "no cycle among the four boards",
);
