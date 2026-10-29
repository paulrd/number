/**
 * Board-tree navigation helpers.
 *
 * A tree edge exists only when both signed sides agree: the parent board has a
 * slot whose contact is the child owner, and the child board's `parent.userId`
 * is the parent owner. A legacy (v2) snapshot has no parent record, so it cannot
 * be the child side, but its signed slots still make it a valid parent side.
 * Everything here is read-only; the caller decides when a board may be edited
 * (`BoardSnapshot` from the own delegate).
 *
 * Reads are cached for the session because breadcrumbs, the parent row and the
 * child status all ask about the same neighbours. The caller clears the cache on
 * reconnect; local writes do not change the remote snapshots it holds.
 */
import type { BoardSnapshot } from "./board";
import type { Contact, Entry, StateV3 } from "./state";
import { errorMessage } from "./util";

export const MAX_TREE_DEPTH = 32;

export type LinkState = "root" | "linked" | "pending" | "not-created" | "error";

export interface LinkInfo {
  state: LinkState;
  /** The other board's owner id; null only for a root. */
  ownerId: string | null;
  snapshot: BoardSnapshot | null;
  /** A readable reason when the check itself failed. */
  error: string | null;
}

export interface LinkDeps {
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
}

export type TrailKind =
  | "current"
  | "ancestor"
  | "pending"
  | "not-created"
  | "unreadable";

export interface TrailStep {
  ownerId: string;
  kind: TrailKind;
  /**
   * The address book of the board just below this step. It is the one that
   * names this board (a child names its parent), so labels stay meaningful on
   * deeper paths where the current board's contacts do not know the ancestor.
   */
  contacts: Contact[];
  /** The target board's own name, from its self-entry. */
  selfName: string | null;
  /**
   * True when this board was read from a previous (v2) contract generation.
   * Its slots still count as the parent side of an edge; only its missing
   * parent record prevents it from being a child. Informational, never a block.
   */
  legacy: boolean;
}

export interface Trail {
  steps: TrailStep[];
  warning: string | null;
}

export interface ChainWalk {
  /** The owner id that matched the target, or null when the target was absent. */
  hitOwnerId: string | null;
  /** The signed chain repeated an owner without reaching the target. */
  loop: boolean;
  /** The depth cap was reached before a conclusion. */
  truncated: boolean;
  /** A read failed; the walk stopped there. */
  error: string | null;
}

/**
 * Follow signed `parent.userId` records from `startOwnerId` toward
 * `targetOwnerId`. This is deliberately independent of the mutual-edge rule:
 * a one-sided (pending) parent is still a possible cycle and must be visited.
 * Breadcrumbs are the only place that follows mutual edges.
 */
export async function walkParentChain(
  startOwnerId: string,
  targetOwnerId: string,
  deps: LinkDeps,
  max = MAX_TREE_DEPTH,
): Promise<ChainWalk> {
  const seen = new Set<string>();
  let cursor: string | null = startOwnerId;
  let links = 0;

  while (cursor !== null) {
    if (cursor === targetOwnerId) {
      return { hitOwnerId: cursor, loop: false, truncated: false, error: null };
    }
    if (seen.has(cursor)) {
      return { hitOwnerId: null, loop: true, truncated: false, error: null };
    }
    seen.add(cursor);
    if (links >= max) {
      return { hitOwnerId: null, loop: false, truncated: true, error: null };
    }

    const result = await read(deps, cursor);
    if (result.error !== null) {
      return {
        hitOwnerId: null,
        loop: false,
        truncated: false,
        error: result.error,
      };
    }
    if (result.snapshot === null || result.snapshot.legacy) {
      // A missing board has no parent; a legacy snapshot has no signed parent
      // record at all. Either one ends the chain.
      return { hitOwnerId: null, loop: false, truncated: false, error: null };
    }
    cursor = result.snapshot.state.parent.userId;
    links += 1;
  }

  return { hitOwnerId: null, loop: false, truncated: false, error: null };
}

/** The contact entry that names a board, i.e. its self-entry. */
export function selfContact(state: StateV3, ownerId: string): Contact | null {
  return (
    state.contacts.entries.find((contact) => contact.userId === ownerId) ?? null
  );
}

/** A board's own name, or null when it has no self-entry yet. */
export function selfNameOf(state: StateV3, ownerId: string): string | null {
  return selfContact(state, ownerId)?.label ?? null;
}

/**
 * Index of the slot in `state` whose contact is `childId`, or null when the
 * board does not list that child. The address digit is this zero-based index;
 * the UI's human slot labels are one-based, so callers must not reuse them.
 */
export function childSlotIndex(state: StateV3, childId: string): number | null {
  const index = state.slots.findIndex(
    (slot) => slot.entry?.contact === childId,
  );
  return index === -1 ? null : index;
}

/** True when a board has a slot pointing at `childId`. */
export function hasChildSlot(state: StateV3, childId: string): boolean {
  return childSlotIndex(state, childId) !== null;
}

/**
 * True when at least one slot names a child whose own parent link points back
 * at `board`.
 *
 * A slot label alone is not an edge: the child must name this board, or the
 * address walk (and therefore any payment route) does not pass through it. A
 * board with a live child can be an intermediate on a payment path; a leaf
 * cannot. Unreadable children are skipped (they cannot be routed through yet).
 */
export async function hasLiveChild(
  board: BoardSnapshot,
  deps: LinkDeps,
): Promise<boolean> {
  for (const slot of board.state.slots) {
    const contact = slot.entry?.contact;
    if (!contact || contact === board.ownerId) continue;
    let child: BoardSnapshot | null = null;
    try {
      child = await deps.readBoard(contact);
    } catch {
      child = null;
    }
    if (child !== null && child.state.parent.userId === board.ownerId) {
      return true;
    }
  }
  return false;
}

/** The parent's signed slot for a child: the value it holds for that board. */
export interface ParentValue {
  /** Zero-based slot index in the parent, i.e. the child's address digit. */
  slot: number;
  entry: Entry;
  parentOwnerId: string;
  /** The parent's own name, when its address book has a self-entry. */
  parentName: string | null;
}

/**
 * The value a parent board holds for `childOwnerId`, or null when the parent
 * has no slot for that child (a pending edge, a cleared slot, or a different
 * child).
 */
export function parentValueFor(
  parent: BoardSnapshot,
  childOwnerId: string,
): ParentValue | null {
  const slot = childSlotIndex(parent.state, childOwnerId);
  if (slot === null) return null;
  const entry = parent.state.slots[slot].entry;
  if (entry === null) return null;
  return {
    slot,
    entry,
    parentOwnerId: parent.ownerId,
    parentName: selfNameOf(parent.state, parent.ownerId),
  };
}

async function read(
  deps: LinkDeps,
  ownerId: string,
): Promise<{ snapshot: BoardSnapshot | null; error: string | null }> {
  try {
    return { snapshot: await deps.readBoard(ownerId), error: null };
  } catch (error) {
    return { snapshot: null, error: errorMessage(error) };
  }
}

/**
 * Status of `board`'s parent link, from the child side. `linked` also requires
 * the parent to list this board in a slot; a parent that exists but has not
 * done so is `pending`.
 */
export async function parentLink(
  board: BoardSnapshot,
  deps: LinkDeps,
): Promise<LinkInfo> {
  const parentId = board.state.parent.userId;
  if (parentId === null) {
    return { state: "root", ownerId: null, snapshot: null, error: null };
  }

  const result = await read(deps, parentId);
  if (result.error !== null) {
    return {
      state: "error",
      ownerId: parentId,
      snapshot: null,
      error: result.error,
    };
  }
  if (result.snapshot === null) {
    return {
      state: "not-created",
      ownerId: parentId,
      snapshot: null,
      error: null,
    };
  }
  // A legacy (v2) board has no parent record, but its signed slots still make
  // it a valid parent side. Never block the edge just because it is legacy.
  return {
    state: hasChildSlot(result.snapshot.state, board.ownerId)
      ? "linked"
      : "pending",
    ownerId: parentId,
    snapshot: result.snapshot,
    error: null,
  };
}

export type AddressProblem =
  | "pending"
  | "not-created"
  | "unreadable"
  | "loop"
  | "truncated";

export interface AddressInfo {
  /**
   * Octal address as zero-based slot digits from the root, with no separator.
   * The empty string is a root board. Null when the chain cannot be resolved.
   */
  address: string | null;
  /** Why the address is unavailable; null when it is known. */
  problem: AddressProblem | null;
  /** The board at which resolution stopped; null when the address is known. */
  blockedBy: string | null;
}

/**
 * Derive a board's octal address by walking mutual parent links to the root.
 * Each link contributes the parent's zero-based slot index for the child
 * (`0`–`7`), appended to the parent's address. A root is the empty string.
 *
 * A one-sided (pending) link has no slot digit, so the address is not settled;
 * a missing, unreadable, or looping ancestor has the same effect. The walk is
 * independent of `buildTrail` so callers can show the address even when the
 * breadcrumb path is truncated or broken.
 */
export async function octalAddress(
  board: BoardSnapshot,
  deps: LinkDeps,
): Promise<AddressInfo> {
  let node = board;
  const digits: string[] = [];
  const seen = new Set<string>([board.ownerId]);

  for (let links = 0; ; links += 1) {
    const parentId = node.state.parent.userId;
    if (parentId === null) {
      return {
        address: digits.reverse().join(""),
        problem: null,
        blockedBy: null,
      };
    }
    if (seen.has(parentId)) {
      return { address: null, problem: "loop", blockedBy: parentId };
    }
    if (links >= MAX_TREE_DEPTH) {
      return { address: null, problem: "truncated", blockedBy: parentId };
    }

    const result = await read(deps, parentId);
    if (result.error !== null) {
      return { address: null, problem: "unreadable", blockedBy: parentId };
    }
    if (result.snapshot === null) {
      return { address: null, problem: "not-created", blockedBy: parentId };
    }

    const slot = childSlotIndex(result.snapshot.state, node.ownerId);
    if (slot === null) {
      return { address: null, problem: "pending", blockedBy: parentId };
    }

    // The address digit is the zero-based slot index, not the one-based label.
    digits.push(String(slot));
    seen.add(parentId);
    node = result.snapshot;
  }
}

/**
 * Status of a child board from the parent's side. The caller knows its own slot
 * already points at `childId`; the missing half is the child's parent record.
 */
export async function childLink(
  parentOwnerId: string,
  childOwnerId: string,
  deps: LinkDeps,
): Promise<LinkInfo> {
  const result = await read(deps, childOwnerId);
  if (result.error !== null) {
    return {
      state: "error",
      ownerId: childOwnerId,
      snapshot: null,
      error: result.error,
    };
  }
  if (result.snapshot === null) {
    return {
      state: "not-created",
      ownerId: childOwnerId,
      snapshot: null,
      error: null,
    };
  }
  // Legacy (v2) state has no signed parent record, so it cannot agree to be a
  // child yet. Its slots are still readable, but the missing half is the
  // parent record: report Pending and let the UI explain the app update.
  return {
    state:
      !result.snapshot.legacy &&
      result.snapshot.state.parent.userId === parentOwnerId
        ? "linked"
        : "pending",
    ownerId: childOwnerId,
    snapshot: result.snapshot,
    error: null,
  };
}

/**
 * Walk the current board's parent links upward, following mutual edges only.
 * The result is ordered root → current. When the next signed parent is not a
 * mutual edge, it is returned as one non-link step at the top and the walk
 * stops there. Loops and the depth cap produce a warning instead of a hang.
 */
export async function buildTrail(
  current: BoardSnapshot,
  deps: LinkDeps,
): Promise<Trail> {
  const ancestors: TrailStep[] = [];
  const seen = new Set<string>([current.ownerId]);
  let node = current;
  let pending: TrailStep | null = null;
  let warning: string | null = null;

  for (let depth = 0; ; depth += 1) {
    const parentId = node.state.parent.userId;
    if (parentId === null) break;

    if (seen.has(parentId)) {
      warning =
        "These boards point at each other in a loop. The path stops at the repeat.";
      break;
    }
    if (depth >= MAX_TREE_DEPTH) {
      warning = `This path is more than ${MAX_TREE_DEPTH} boards deep. The path stops here.`;
      break;
    }

    const result = await read(deps, parentId);
    if (result.error !== null) {
      pending = {
        ownerId: parentId,
        kind: "unreadable",
        contacts: node.state.contacts.entries,
        selfName: null,
        legacy: false,
      };
      warning = "Could not read part of this path. The path may be incomplete.";
      break;
    }
    if (result.snapshot === null) {
      pending = {
        ownerId: parentId,
        kind: "not-created",
        contacts: node.state.contacts.entries,
        selfName: null,
        legacy: false,
      };
      break;
    }
    if (!hasChildSlot(result.snapshot.state, node.ownerId)) {
      pending = {
        ownerId: parentId,
        kind: "pending",
        contacts: node.state.contacts.entries,
        selfName: selfNameOf(result.snapshot.state, parentId),
        legacy: result.snapshot.legacy,
      };
      break;
    }

    seen.add(parentId);
    ancestors.push({
      ownerId: parentId,
      kind: "ancestor",
      contacts: node.state.contacts.entries,
      selfName: selfNameOf(result.snapshot.state, parentId),
      legacy: result.snapshot.legacy,
    });
    node = result.snapshot;
  }

  const steps: TrailStep[] = [];
  if (pending !== null) steps.push(pending);
  steps.push(...ancestors.reverse());
  steps.push({
    ownerId: current.ownerId,
    kind: "current",
    // There is no board below the current step in the mutual chain, so the
    // current board's own address book is not a "child names its parent"
    // source. Its self-entry is exposed separately as `selfName`.
    contacts: [],
    selfName: selfNameOf(current.state, current.ownerId),
    legacy: current.legacy,
  });
  return { steps, warning };
}

/**
 * Session cache for `readBoard`. Concurrent requests for the same owner share
 * one read. The own board is never cached here; the caller resolves it from the
 * live delegate state so Home is always current.
 */
export class BoardCache {
  private readonly entries = new Map<string, BoardSnapshot | null>();
  private readonly inflight = new Map<
    string,
    Promise<BoardSnapshot | null>
  >();
  private generation = 0;

  constructor(
    private readonly loader: (ownerId: string) => Promise<BoardSnapshot | null>,
  ) {}

  async get(ownerId: string): Promise<BoardSnapshot | null> {
    if (this.entries.has(ownerId)) {
      return this.entries.get(ownerId) ?? null;
    }
    const existing = this.inflight.get(ownerId);
    if (existing) return existing;

    const generation = this.generation;
    const request = this.loader(ownerId)
      .then((snapshot) => {
        if (generation === this.generation) {
          this.entries.set(ownerId, snapshot);
        }
        return snapshot;
      })
      .finally(() => {
        // `clear()` already dropped in-flight entries for an older generation.
        if (generation === this.generation) {
          this.inflight.delete(ownerId);
        }
      });
    this.inflight.set(ownerId, request);
    return request;
  }

  /** Drop every cached read; increments a generation to ignore in-flight ones. */
  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
  }
}
