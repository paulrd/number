/**
 * Cooperative payment routing.
 *
 * A payment moves from a source board to a destination board through their
 * least common ancestor (LCA). The source and destination addresses are
 * zero-based slot-digit strings from the same root (`""` is the root). Each
 * route step is signed by exactly one board owner; see `DESIGN-payments.md`.
 *
 * This module is deliberately pure. Board reads, signing and writes live in the
 * caller so the route can be unit-tested without a node.
 */
import { blake3 } from "@noble/hashes/blake3";
import type { BoardSnapshot } from "./board";
import { I64_MAX, type Entry } from "./state";
import { childSlotIndex, MAX_TREE_DEPTH, octalAddress } from "./tree-view";
import { bytesToHex } from "./util";

export const MAX_PAYMENT_ADDRESS = 32;
export const MAX_PAYMENT_LEGS = 2;

export type PaymentPhase = "forward" | "reverse" | "terminal";
export type PaymentStatus =
  | "offered"
  | "acted"
  | "complete"
  | "reversing"
  | "reversed"
  | "aborted"
  | "blocked"
  | "superseded";
export type PaymentFail =
  | "negative"
  | "no-destination"
  | "busy"
  | "refused"
  | "address-mismatch"
  | "blocked"
  | "superseded";

/** One signed slot write made by an actor. */
export interface PaymentLeg {
  slot: number;
  seq: number;
  /** The signed value after the leg, in hundredths. */
  postValue: bigint;
  sig: string;
}

/**
 * One payment intent as carried in a board's `payments` record. Everything is
 * covered by the record signature. `cursor` is the number of route hops already
 * applied; the LCA advances it by two because its pair is one delta.
 */
export interface PaymentEntry {
  id: string;
  src: string;
  dst: string;
  amount: bigint;
  srcAddr: string;
  dstAddr: string;
  cursor: number;
  phase: PaymentPhase;
  status: PaymentStatus;
  /** Owner expected to act next; all-zero when terminal. */
  next: string;
  fail: PaymentFail | null;
  legs: PaymentLeg[];
}

/** The signed per-board payment record. One active intent at most. */
export interface PaymentsRecord {
  seq: number;
  /** Recently settled payment ids, oldest first, capped by the contract. */
  settled: string[];
  entry: PaymentEntry | null;
  sig: string | null;
}

export const ZERO_OWNER = "0".repeat(64);

export function isTerminalPhase(entry: PaymentEntry): boolean {
  return entry.phase === "terminal" && entry.next === ZERO_OWNER;
}

export type RouteError =
  | "invalid-address"
  | "same-address"
  | "source-at-lca"
  | "destination-at-lca";

export interface PaymentRoute {
  srcAddr: string;
  dstAddr: string;
  /** Length of the longest common prefix. */
  lcaLength: number;
  /** Upward hops (debits), at least 1. */
  debitHops: number;
  /** Downward hops (credits), at least 1. */
  creditHops: number;
  /** Total hops. */
  hops: number;
  lcaAddr: string;
}

export type StepError =
  | "invalid-cursor"
  | "not-an-actor"
  | "invalid-own-address";

export type SlotDirection = "debit" | "credit";

export interface StepSlot {
  /** Zero-based slot index in the acting board. */
  slot: number;
  direction: SlotDirection;
}

export interface ActorStep {
  role: "source" | "debit" | "lca" | "credit" | "terminal";
  /** The octal address the acting board must currently have. */
  ownAddress: string;
  /** Slots this actor writes; empty for source/terminal. */
  slots: StepSlot[];
  /** Cursor after this actor's delta. */
  nextCursor: number;
  /** Expected address of the next actor, or null at terminal. */
  nextAddress: string | null;
}

/** True for a string of at most 32 octal digits, with no leading conversion. */
export function isOctalAddress(value: string): boolean {
  return (
    value.length <= MAX_PAYMENT_ADDRESS &&
    Array.from(value).every((digit) => digit >= "0" && digit <= "7")
  );
}

/** Length of the shared prefix of two addresses. */
export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Plan the path between two addresses. A payment needs at least one debit and
 * one credit, so neither endpoint may be the LCA (including the root).
 */
export function planRoute(
  srcAddr: string,
  dstAddr: string,
): PaymentRoute | { error: RouteError } {
  if (!isOctalAddress(srcAddr) || !isOctalAddress(dstAddr)) {
    return { error: "invalid-address" };
  }
  if (srcAddr === dstAddr) return { error: "same-address" };

  const lcaLength = commonPrefixLength(srcAddr, dstAddr);
  const debitHops = srcAddr.length - lcaLength;
  const creditHops = dstAddr.length - lcaLength;
  if (debitHops === 0) return { error: "source-at-lca" };
  if (creditHops === 0) return { error: "destination-at-lca" };

  return {
    srcAddr,
    dstAddr,
    lcaLength,
    debitHops,
    creditHops,
    hops: debitHops + creditHops,
    lcaAddr: srcAddr.slice(0, lcaLength),
  };
}

/** The expected actor for `cursor`, optionally checking the board's address. */
export function actorStep(
  route: PaymentRoute,
  cursor: number,
  ownAddress?: string,
): ActorStep | { error: StepError } {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > route.hops) {
    return { error: "invalid-cursor" };
  }

  let step: ActorStep;
  if (cursor === route.hops) {
    step = {
      role: "terminal",
      ownAddress: "",
      slots: [],
      nextCursor: cursor,
      nextAddress: null,
    };
    // A terminal step has no acting board; only the cursor check matters.
    return step;
  }

  if (cursor === route.debitHops) {
    // The LCA's second logical hop is part of its single paired delta. A cursor
    // at this position would otherwise look like a downward act at the root.
    return { error: "invalid-cursor" };
  }

  if (cursor === 0 && ownAddress === route.srcAddr) {
    // The source owns the intent but has no edge of its own to sign: its
    // incoming value lives in its parent's slot. It points at its parent.
    step = {
      role: "source",
      ownAddress: route.srcAddr,
      slots: [],
      nextCursor: 0,
      nextAddress: route.srcAddr.slice(0, -1),
    };
  } else if (cursor < route.debitHops - 1) {
    // Upward leg in an ancestor: the slot points at the child below.
    const depth = route.srcAddr.length - 1 - cursor;
    step = {
      role: "debit",
      ownAddress: route.srcAddr.slice(0, depth),
      slots: [
        {
          slot: Number(route.srcAddr[depth]),
          direction: "debit",
        },
      ],
      nextCursor: cursor + 1,
      nextAddress: route.srcAddr.slice(0, depth - 1),
    };
  } else if (cursor === route.debitHops - 1) {
    // The LCA debits the source side and credits the destination side.
    step = {
      role: "lca",
      ownAddress: route.lcaAddr,
      slots: [
        {
          slot: Number(route.srcAddr[route.lcaLength]),
          direction: "debit",
        },
        {
          slot: Number(route.dstAddr[route.lcaLength]),
          direction: "credit",
        },
      ],
      nextCursor: route.debitHops + 1,
      nextAddress:
        route.creditHops === 1
          ? null
          : route.dstAddr.slice(0, route.lcaLength + 1),
    };
  } else {
    // Downward leg: credit the child at the next digit.
    const depth = route.lcaLength + (cursor - route.debitHops);
    step = {
      role: "credit",
      ownAddress: route.dstAddr.slice(0, depth),
      slots: [
        {
          slot: Number(route.dstAddr[depth]),
          direction: "credit",
        },
      ],
      nextCursor: cursor + 1,
      nextAddress:
        cursor + 1 === route.hops
          ? null
          : route.dstAddr.slice(0, depth + 1),
    };
  }

  if (ownAddress !== undefined && ownAddress !== step.ownAddress) {
    return { error: "not-an-actor" };
  }
  return step;
}

/** Deterministic id: BLAKE3(src || srcSeq || dst || amount)[0..16] hex. */
export function paymentId(
  src: string,
  srcSeq: number,
  dst: string,
  amount: bigint,
): string {
  const srcBytes = hexToFixed(src, 32);
  const dstBytes = hexToFixed(dst, 32);
  const buffer = new Uint8Array(32 + 8 + 32 + 8);
  buffer.set(srcBytes, 0);
  const view = new DataView(buffer.buffer);
  view.setBigUint64(32, BigInt(srcSeq), true);
  buffer.set(dstBytes, 40);
  view.setBigInt64(48, amount, true);
  return bytesToHex(blake3(buffer).slice(0, 16));
}

function hexToFixed(value: string, length: number): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length !== length * 2) {
    throw new Error(`expected ${length * 2} lowercase hex characters`);
  }
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** A short human description of the route, for status text. */
export function describeRoute(route: PaymentRoute): string {
  return `${route.srcAddr || "root"} → ${route.lcaAddr || "root"} → ${
    route.dstAddr || "root"
  }`;
}

/** One slot write that belongs to a payment leg. */
export interface PaymentSlotWrite {
  index: number;
  entry: Entry;
}

/** The board-level effects the payment protocol needs. */
export interface PaymentDeps {
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
  /**
   * Sign and persist one payments record plus its slot writes in one delta.
   * Returns the record actually signed, with `legs` filled from the slot
   * writes. A null entry clears the record and returns null.
   */
  savePayment(
    entry: PaymentEntry | null,
    slots: PaymentSlotWrite[],
  ): Promise<PaymentEntry | null>;
}

export type PaymentProblem =
  | RouteError
  | "invalid-amount"
  | "busy"
  | "unreadable"
  | "not-created"
  | "pending"
  | "legacy"
  | "loop"
  | "too-deep"
  | "no-destination"
  | "address-mismatch"
  | "different-roots"
  | "missing-slot"
  | "negative"
  | "overflow"
  | "no-intent"
  | "not-actor"
  | "not-owner"
  | "invalid-intent"
  | "blocked"
  | "superseded";

export interface PaymentFailure {
  ok: false;
  problem: PaymentProblem;
  detail: string;
  /** Route hop that failed, when known. */
  hop?: number;
}

export interface PlanActor {
  ownerId: string;
  address: string;
  step: ActorStep;
}

export interface PaymentPlan {
  source: BoardSnapshot;
  destination: BoardSnapshot;
  route: PaymentRoute;
  amount: bigint;
  /** Root -> source. */
  srcChain: BoardSnapshot[];
  /** Root -> destination. */
  dstPath: BoardSnapshot[];
  /** Boards that will sign a leg, in route order. The source is not here. */
  actors: PlanActor[];
}

export interface IncomingPayment {
  /** The adjacent board whose signed record carries the intent. */
  from: BoardSnapshot;
  entry: PaymentEntry;
}

function failure(
  problem: PaymentProblem,
  detail: string,
  hop?: number,
): PaymentFailure {
  return { ok: false, problem, detail, hop };
}

function isFailure(value: unknown): value is PaymentFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false
  );
}

function actorAddressAt(route: PaymentRoute, hop: number): string | null {
  if (hop < route.debitHops - 1) {
    return route.srcAddr.slice(0, route.srcAddr.length - 1 - hop);
  }
  if (hop === route.debitHops - 1) return route.lcaAddr;
  if (hop === route.debitHops) return null;
  if (hop >= route.debitHops + 1) {
    return route.dstAddr.slice(0, route.lcaLength + (hop - route.debitHops));
  }
  return null;
}

function addressOfChain(chain: BoardSnapshot[]): string | null {
  let address = "";
  for (let index = 1; index < chain.length; index += 1) {
    const slot = childSlotIndex(chain[index - 1].state, chain[index].ownerId);
    if (slot === null) return null;
    address += String(slot);
  }
  return address;
}

async function readNeighbour(
  deps: Pick<PaymentDeps, "readBoard">,
  ownerId: string,
): Promise<BoardSnapshot | null | PaymentFailure> {
  try {
    return await deps.readBoard(ownerId);
  } catch {
    return failure("unreadable", `Could not read board ${ownerId}.`);
  }
}

/** Walk mutual parent links from a board to its root (root first). */
async function mutualChain(
  board: BoardSnapshot,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<BoardSnapshot[] | PaymentFailure> {
  const chain = [board];
  const seen = new Set([board.ownerId]);
  let node = board;

  for (let links = 0; ; links += 1) {
    const parentId = node.state.parent.userId;
    if (parentId === null) return chain.reverse();
    if (seen.has(parentId)) {
      return failure("loop", "The parent links form a loop.");
    }
    if (links >= MAX_TREE_DEPTH) {
      return failure("too-deep", `The path is more than ${MAX_TREE_DEPTH} boards deep.`);
    }
    const parent = await readNeighbour(deps, parentId);
    if (isFailure(parent)) return parent;
    if (parent === null) {
      return failure("not-created", "A parent board has not been created yet.");
    }
    if (childSlotIndex(parent.state, node.ownerId) === null) {
      return failure("pending", "A parent board has not added this board yet.");
    }
    seen.add(parentId);
    chain.push(parent);
    node = parent;
  }
}

/** Resolve an octal address from `root` to the board it names. */
async function resolveAddress(
  root: BoardSnapshot,
  address: string,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<BoardSnapshot[] | PaymentFailure> {
  const path = [root];
  let node = root;
  for (let depth = 0; depth < address.length; depth += 1) {
    const slot = Number(address[depth]);
    const entry = node.state.slots[slot]?.entry ?? null;
    if (entry === null) {
      return failure(
        "no-destination",
        `Slot ${slot} is empty at address prefix ${address.slice(0, depth)}.`,
      );
    }
    const child = await readNeighbour(deps, entry.contact);
    if (isFailure(child)) return child;
    if (child === null) {
      return failure(
        "not-created",
        `The board at address prefix ${address.slice(0, depth + 1)} does not exist.`,
      );
    }
    if (child.legacy) {
      return failure(
        "legacy",
        `The board at address ${address.slice(0, depth + 1)} is on the previous version.`,
      );
    }
    if (child.state.parent.userId !== node.ownerId) {
      return failure(
        "pending",
        `The board at address ${address.slice(0, depth + 1)} has not confirmed its parent.`,
      );
    }
    path.push(child);
    node = child;
  }
  return path;
}

function actorOwnerAt(plan: {
  srcChain: BoardSnapshot[];
  dstPath: BoardSnapshot[];
  route: PaymentRoute;
}, hop: number): BoardSnapshot | null {
  const { route } = plan;
  if (hop < route.debitHops - 1) {
    return plan.srcChain[route.srcAddr.length - 1 - hop] ?? null;
  }
  if (hop === route.debitHops - 1) {
    return plan.srcChain[route.lcaLength] ?? null;
  }
  if (hop <= route.debitHops) return null;
  return plan.dstPath[route.lcaLength + (hop - route.debitHops)] ?? null;
}

/**
 * Resolve both addresses, prove the mutual route, check every debit and
 * credit the payment will touch, and return the actor list. Does not write.
 */
export async function planPayment(
  source: BoardSnapshot,
  dstAddr: string,
  dstId: string,
  amount: bigint,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<PaymentPlan | PaymentFailure> {
  if (amount <= 0n || amount > I64_MAX) {
    return failure("invalid-amount", "Enter an amount greater than zero.");
  }
  if (!/^[0-9a-f]{64}$/.test(dstId)) {
    return failure("address-mismatch", "The user id must be 64 lowercase hex characters.");
  }
  const existing = source.state.payments.entry;
  if (existing !== null && existing.phase !== "terminal") {
    // The source's own copy stays at its offered/acted state after the route
    // completes. Follow the signed chain so a settled payment can be replaced;
    // only a genuinely in-flight one is busy.
    let settled: PaymentEntry;
    try {
      settled = await paymentProgress(source, existing, deps);
    } catch {
      return failure("unreadable", "Could not read the existing payment's progress.");
    }
    if (settled.phase !== "terminal") {
      return failure("busy", "This board already has a payment in progress.");
    }
  }

  const chain = await mutualChain(source, deps);
  if (!Array.isArray(chain)) return chain;
  const srcAddr = addressOfChain(chain);
  if (srcAddr === null) {
    return failure("pending", "The source board's parent chain is not mutual.");
  }

  const route = planRoute(srcAddr, dstAddr);
  if ("error" in route) return failure(route.error, "The addresses cannot be routed.");

  const root = chain[0];
  const dstPath = await resolveAddress(root, dstAddr, deps);
  if (!Array.isArray(dstPath)) return dstPath;
  const destination = dstPath[dstPath.length - 1];
  if (destination.ownerId !== dstId) {
    return failure(
      "address-mismatch",
      "The supplied user id does not own the board at that octal address.",
    );
  }
  if (chain[route.lcaLength]?.ownerId !== dstPath[route.lcaLength]?.ownerId) {
    return failure("different-roots", "The two addresses do not share one root.");
  }

  const actorHops: number[] = [];
  for (let hop = 0; hop < route.debitHops - 1; hop += 1) actorHops.push(hop);
  actorHops.push(route.debitHops - 1); // the LCA's paired turn
  for (let hop = route.debitHops + 1; hop < route.hops; hop += 1) {
    actorHops.push(hop);
  }

  const actors: PlanActor[] = [];
  for (const hop of actorHops) {
    const actor = actorOwnerAt({ srcChain: chain, dstPath, route }, hop);
    const address = actorAddressAt(route, hop);
    if (actor === null || address === null) {
      return failure("invalid-intent", `No board at route hop ${hop}.`);
    }
    const step = actorStep(route, hop, address);
    if ("error" in step) {
      return failure("invalid-intent", `Route hop ${hop} has no actor.`, hop);
    }
    actors.push({ ownerId: actor.ownerId, address, step });
  }

  // Preflight every leg. The negative rule is checked against the value that
  // will be debited, not a computed balance.
  for (let index = 0; index < actors.length; index += 1) {
    const hop = actorHops[index];
    const actor = actorOwnerAt({ srcChain: chain, dstPath, route }, hop);
    if (actor === null) continue;
    if (actor.legacy) {
      return failure(
        "legacy",
        `The board at route hop ${hop} is on the previous version.`,
        hop,
      );
    }
    for (const leg of actors[index].step.slots) {
      const slot = actor.state.slots[leg.slot];
      if (slot?.entry === null || slot?.entry === undefined) {
        return failure(
          "missing-slot",
          `Route hop ${hop} uses an empty slot ${leg.slot}.`,
          hop,
        );
      }
      if (leg.direction === "debit") {
        if (slot.entry.value < amount) {
          return failure(
            "negative",
            `Slot ${leg.slot} holds ${slot.entry.value}; it cannot pay ${amount}.`,
            hop,
          );
        }
      } else if (slot.entry.value > I64_MAX - amount) {
        return failure(
          "overflow",
          `Slot ${leg.slot} cannot hold the credited amount.`,
          hop,
        );
      }
    }
  }

  return {
    source,
    destination,
    route,
    amount,
    srcChain: chain,
    dstPath,
    actors,
  };
}

/** Build the source-board intent at the source's payment record seq. */
export function createPaymentIntent(
  plan: PaymentPlan,
  sourceSeq: number,
): PaymentEntry {
  const first = plan.actors[0];
  if (first === undefined) throw new Error("A payment route must have an actor.");
  return {
    id: paymentId(plan.source.ownerId, sourceSeq, plan.destination.ownerId, plan.amount),
    src: plan.source.ownerId,
    dst: plan.destination.ownerId,
    amount: plan.amount,
    srcAddr: plan.route.srcAddr,
    dstAddr: plan.route.dstAddr,
    cursor: 0,
    phase: "forward",
    status: "offered",
    next: first.ownerId,
    fail: null,
    legs: [],
  };
}

/**
 * The intent is carried in a board's own signed record. A board's inbox is its
 * parent plus its direct children, so an intent two levels away is invisible
 * until the middle board forwards it.
 */
export async function findIncoming(
  board: BoardSnapshot,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<IncomingPayment[]> {
  const neighbours = new Map<string, BoardSnapshot>();
  const parentId = board.state.parent.userId;
  if (parentId !== null) {
    const parent = await readNeighbour(deps, parentId);
    if (parent !== null && !("ok" in parent)) neighbours.set(parent.ownerId, parent);
  }
  for (const slot of board.state.slots) {
    if (slot.entry !== null) {
      const child = await readNeighbour(deps, slot.entry.contact);
      if (child !== null && !("ok" in child)) neighbours.set(child.ownerId, child);
    }
  }

  const found: IncomingPayment[] = [];
  const own = board.state.payments.entry;
  for (const from of neighbours.values()) {
    const entry = from.state.payments.entry;
    if (
      entry === null ||
      entry.next !== board.ownerId ||
      entry.phase === "terminal"
    ) {
      continue;
    }
    if (board.state.payments.settled.includes(entry.id)) {
      // This board already settled and moved past this exact payment id.
      continue;
    }
    if (own?.id === entry.id) {
      // A forward copy already acted on by this board (or a completed payment)
      // must not appear again. A reverse copy is a different direction and must
      // still be offered even though the forward leg is in the own record.
      if (
        own.phase === "terminal" ||
        (entry.phase !== "reverse" &&
          (own.phase === "reverse" || own.cursor >= entry.cursor))
      ) {
        continue;
      }
    }
    found.push({ from, entry });
  }
  return found;
}

async function boardAddress(
  board: BoardSnapshot,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<string | null> {
  const info = await octalAddress(board, deps);
  return info.address;
}

function slotContact(board: BoardSnapshot, slot: number): string | null {
  return board.state.slots[slot]?.entry?.contact ?? null;
}

/** Owner of the board before `hop` on the route (the source for hop 0). */
function previousOwnerForHop(
  board: BoardSnapshot,
  route: PaymentRoute,
  hop: number,
  entry: PaymentEntry,
): string {
  if (hop <= 0) return entry.src;
  if (hop < route.debitHops - 1) {
    const digit = Number(route.srcAddr[route.srcAddr.length - 1 - hop]);
    return slotContact(board, digit) ?? entry.src;
  }
  if (hop === route.debitHops - 1 || hop === route.debitHops) {
    if (route.debitHops === 1) return entry.src;
    const digit = Number(route.srcAddr[route.lcaLength]);
    return slotContact(board, digit) ?? entry.src;
  }
  return board.state.parent.userId ?? entry.src;
}

/**
 * The neighbour that should carry a reverse request into this board. At reverse
 * cursor c the requester is the actor at hop c (the one that failed or just
 * undid its leg); the current board is the actor at hop c-1.
 */
function reverseRequester(
  board: BoardSnapshot,
  route: PaymentRoute,
  entry: PaymentEntry,
): string | null {
  const cursor = entry.cursor;
  if (cursor <= 0 || cursor <= route.debitHops - 1) {
    return board.state.parent.userId;
  }
  if (cursor >= route.debitHops + 1) {
    const index = route.lcaLength + (cursor - route.debitHops - 1);
    if (index < 0 || index >= route.dstAddr.length) return null;
    return slotContact(board, Number(route.dstAddr[index]));
  }
  return null;
}

function nextOwnerForStep(
  board: BoardSnapshot,
  step: ActorStep,
): string {
  if (step.nextAddress === null) return ZERO_OWNER;
  if (step.role === "debit") {
    return board.state.parent.userId ?? ZERO_OWNER;
  }
  const credit = step.slots.find((slot) => slot.direction === "credit");
  if (credit !== undefined) {
    return slotContact(board, credit.slot) ?? ZERO_OWNER;
  }
  return ZERO_OWNER;
}

function failFor(problem: PaymentProblem): PaymentFail {
  if (problem === "negative") return "negative";
  if (problem === "no-destination") return "no-destination";
  if (problem === "address-mismatch") return "address-mismatch";
  if (problem === "overflow" || problem === "missing-slot") return "blocked";
  return "refused";
}

/** A failing actor records the failure and points at the previous actor. */
async function writeReverseAbort(
  board: BoardSnapshot,
  entry: PaymentEntry,
  route: PaymentRoute,
  problem: PaymentProblem,
  deps: PaymentDeps,
): Promise<PaymentEntry> {
  const previous = previousOwnerForHop(board, route, entry.cursor, entry);
  const reverse: PaymentEntry = {
    ...entry,
    phase: "reverse",
    status: "aborted",
    cursor: entry.cursor,
    next: previous,
    fail: failFor(problem),
    legs: [],
  };
  const saved = await deps.savePayment(reverse, []);
  if (saved === null) throw new Error("The payment record was not signed.");
  return saved;
}

async function destinationStillValid(
  board: BoardSnapshot,
  entry: PaymentEntry,
  step: ActorStep,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<PaymentProblem | null> {
  const credit = step.slots.find((slot) => slot.direction === "credit");
  if (credit === undefined) return "invalid-intent";
  const contact = slotContact(board, credit.slot);
  if (contact !== entry.dst) return "address-mismatch";
  const destination = await readNeighbour(deps, entry.dst);
  if (destination === null || isFailure(destination)) {
    return "no-destination";
  }
  if (destination.ownerId !== entry.dst) return "address-mismatch";
  if (destination.state.parent.userId !== board.ownerId) return "address-mismatch";
  return null;
}

async function reversePayment(
  board: BoardSnapshot,
  entry: PaymentEntry,
  route: PaymentRoute,
  deps: PaymentDeps,
): Promise<PaymentEntry> {
  const ownAddress = await boardAddress(board, deps);
  if (ownAddress === null) throw new Error("The board's octal address is unknown.");

  // The reverse copy is attacker-controlled data. Bind every immutable field to
  // this board's own signed record before using its amount, route or direction.
  const own = board.state.payments.entry;
  if (
    own === null ||
    own.id !== entry.id ||
    own.src !== entry.src ||
    own.dst !== entry.dst ||
    own.amount !== entry.amount ||
    own.srcAddr !== entry.srcAddr ||
    own.dstAddr !== entry.dstAddr
  ) {
    throw new Error("The reverse request does not match this board's signed record.");
  }

  if (entry.cursor === 0 && ownAddress === own.srcAddr) {
    // The source has no leg; it closes the reverse walk. The own-record check
    // above prevents a neighbour from clobbering a newer offer.
    const terminal: PaymentEntry = {
      ...own,
      phase: "terminal",
      status: entry.status === "blocked" ? "blocked" : "reversed",
      next: ZERO_OWNER,
      legs: [],
    };
    const saved = await deps.savePayment(terminal, []);
    if (saved === null) throw new Error("The payment record was not signed.");
    return saved;
  }

  if (!Number.isInteger(entry.cursor) || entry.cursor <= 0) {
    throw new Error("The reverse cursor is not valid.");
  }

  const isLca =
    ownAddress === route.lcaAddr &&
    entry.cursor === route.debitHops + 1;
  const hop = isLca ? route.debitHops - 1 : entry.cursor - 1;
  const expectedCursor = hop + (isLca ? 2 : 1);
  if (own.phase !== "forward" || own.status !== "acted" || own.cursor !== expectedCursor) {
    throw new Error("This board's signed leg is not the one being reversed.");
  }
  const step = actorStep(route, hop, ownAddress);
  if ("error" in step) throw new Error("The reverse actor does not match the route.");

  const directions = new Map(
    step.slots.map((slot) => [slot.slot, slot.direction] as const),
  );
  let blocked: PaymentProblem | null = null;
  let superseded = false;
  const writes: PaymentSlotWrite[] = [];

  for (const leg of own.legs) {
    const slot = board.state.slots[leg.slot];
    if (
      slot === undefined ||
      slot.entry === null ||
      slot.seq !== leg.seq ||
      slot.sig !== leg.sig
    ) {
      superseded = true;
      continue;
    }
    const direction = directions.get(leg.slot);
    if (direction === undefined) {
      superseded = true;
      continue;
    }
    if (direction === "debit") {
      // Undoing a debit means crediting it back.
      if (slot.entry.value > I64_MAX - own.amount) {
        blocked = "overflow";
        break;
      }
      writes.push({
        index: leg.slot,
        entry: { ...slot.entry, value: slot.entry.value + own.amount },
      });
    } else {
      // Undoing a credit means debiting it; this cannot go negative.
      if (slot.entry.value < own.amount) {
        blocked = "negative";
        break;
      }
      writes.push({
        index: leg.slot,
        entry: { ...slot.entry, value: slot.entry.value - own.amount },
      });
    }
  }

  if (blocked !== null || superseded) {
    const terminal: PaymentEntry = {
      ...entry,
      phase: "terminal",
      status: blocked !== null ? "blocked" : "superseded",
      next: ZERO_OWNER,
      fail: blocked !== null ? failFor(blocked) : "superseded",
      legs: own.legs,
    };
    const saved = await deps.savePayment(terminal, []);
    if (saved === null) throw new Error("The payment record was not signed.");
    return saved;
  }

  const newCursor = isLca ? route.debitHops - 1 : hop;
  const previous = previousOwnerForHop(board, route, hop, entry);
  const reverse: PaymentEntry = {
    ...entry,
    phase: "reverse",
    status: "reversing",
    cursor: newCursor,
    next: previous,
    fail: entry.fail,
    legs: own.legs,
  };
  const saved = await deps.savePayment(reverse, writes);
  if (saved === null) throw new Error("The payment record was not signed.");
  return saved;
}

/**
 * Follow the signed records forward from the source entry and return the most
 * advanced copy. This is how the source shows progress without a push channel;
 * the caller should clear or refresh its board cache first if it wants a fresh
 * read.
 */
export async function paymentProgress(
  source: BoardSnapshot,
  entry: PaymentEntry,
  deps: Pick<PaymentDeps, "readBoard">,
): Promise<PaymentEntry> {
  let best = entry;
  let cursor: string = entry.next;
  const seen = new Set<string>([entry.src]);
  for (let hop = 0; hop < 64 && cursor !== ZERO_OWNER; hop += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const board =
      cursor === source.ownerId ? source : await deps.readBoard(cursor);
    if (board === null) break;
    const candidate = board.state.payments.entry;
    if (candidate === null || candidate.id !== entry.id) {
      if (board.state.payments.settled.includes(entry.id)) {
        // The next actor already replaced its copy; its settled list is the
        // durable evidence that this payment left the forward chain.
        best = {
          ...best,
          phase: "terminal",
          status:
            best.status === "acted" || best.status === "offered"
              ? "complete"
              : best.status,
          next: ZERO_OWNER,
        };
      }
      break;
    }
    if (
      candidate.cursor > best.cursor ||
      (candidate.cursor === best.cursor &&
        phaseRank(candidate.phase) > phaseRank(best.phase))
    ) {
      best = candidate;
    }
    cursor = candidate.next;
  }
  return best;
}

function phaseRank(phase: PaymentPhase): number {
  return phase === "terminal" ? 2 : phase === "reverse" ? 1 : 0;
}

/**
 * Apply one forward or reverse leg on `board`. The caller must own `board`.
 * `from` is the adjacent board that carried the intent into this inbox; it is
 * used only for diagnostics. The returned entry is the one this board signed.
 */
export async function advancePayment(
  board: BoardSnapshot,
  from: BoardSnapshot,
  entry: PaymentEntry,
  deps: PaymentDeps,
): Promise<PaymentEntry> {
  if (entry.next !== board.ownerId) {
    throw new Error("This board is not the next actor for the payment.");
  }
  const route = planRoute(entry.srcAddr, entry.dstAddr);
  if ("error" in route) throw new Error("The payment route is malformed.");

  const fromEntry = from.state.payments.entry;
  if (fromEntry === null || fromEntry.id !== entry.id) {
    throw new Error("The neighbour did not carry the matching signed intent.");
  }

  if (entry.phase === "reverse") {
    const expected = reverseRequester(board, route, entry);
    if (expected === null || from.ownerId !== expected) {
      throw new Error("The reverse request did not come from the next actor.");
    }
    if (fromEntry.phase !== "reverse" || fromEntry.cursor !== entry.cursor) {
      throw new Error("The reverse request is not the signed next step.");
    }
    return reversePayment(board, entry, route, deps);
  }
  if (entry.phase === "terminal") {
    throw new Error("The payment is already terminal.");
  }
  const previousOwner = previousOwnerForHop(board, route, entry.cursor, entry);
  if (from.ownerId !== previousOwner) {
    throw new Error("The intent did not come from the previous route actor.");
  }
  if (
    entry.cursor > 0 &&
    (fromEntry.phase !== "forward" || fromEntry.cursor !== entry.cursor)
  ) {
    throw new Error("The previous actor has not signed the expected leg.");
  }
  const ownEntry = board.state.payments.entry;
  if (ownEntry !== null && ownEntry.phase !== "terminal") {
    // A previous payment may have finished after this board signed its leg.
    // Follow the signed chain (or the next board's settled list) before
    // refusing a new one.
    const progressed = await paymentProgress(board, ownEntry, deps);
    if (progressed.phase !== "terminal") {
      throw new Error("This board already has an active payment.");
    }
  }

  const ownAddress = await boardAddress(board, deps);
  if (ownAddress === null) throw new Error("The board's octal address is unknown.");
  const step = actorStep(route, entry.cursor, ownAddress);
  if ("error" in step) throw new Error("This board is not the expected route actor.");

  if (step.role === "source") {
    throw new Error("The source has no leg to apply.");
  }

  // The first upward actor must be debiting the slot that actually names the
  // claimed source. Without this check a neighbour can point srcAddr at any
  // rich sibling while signing src as itself.
  if (entry.cursor === 0) {
    const debit = step.slots.find((slot) => slot.direction === "debit");
    if (debit === undefined || slotContact(board, debit.slot) !== entry.src) {
      throw new Error("The source id does not match the debited slot.");
    }
  }

  const writes: PaymentSlotWrite[] = [];
  for (const leg of step.slots) {
    const slot = board.state.slots[leg.slot];
    if (slot.entry === null) {
      return writeReverseAbort(board, entry, route, "missing-slot", deps);
    }
    if (leg.direction === "debit" && slot.entry.value < entry.amount) {
      return writeReverseAbort(board, entry, route, "negative", deps);
    }
    if (leg.direction === "credit" && slot.entry.value > I64_MAX - entry.amount) {
      return writeReverseAbort(board, entry, route, "overflow", deps);
    }
    writes.push({
      index: leg.slot,
      entry: {
        ...slot.entry,
        value:
          leg.direction === "debit"
            ? slot.entry.value - entry.amount
            : slot.entry.value + entry.amount,
      },
    });
  }

  if (step.nextAddress === null) {
    const problem = await destinationStillValid(board, entry, step, deps);
    if (problem !== null) {
      return writeReverseAbort(board, entry, route, problem, deps);
    }
  }

  const terminal = step.nextAddress === null;
  const forward: PaymentEntry = {
    ...entry,
    phase: terminal ? "terminal" : "forward",
    status: terminal ? "complete" : "acted",
    cursor: step.nextCursor,
    next: nextOwnerForStep(board, step),
    fail: null,
    legs: [],
  };
  const saved = await deps.savePayment(forward, writes);
  if (saved === null) throw new Error("The payment record was not signed.");
  return saved;
}

