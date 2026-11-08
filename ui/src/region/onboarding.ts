/**
 * Pure discovery flow for a `?root=` invite.
 *
 * The surface (map, chain, request form) is built on these functions; they take
 * a `ZoneReader` callback and a dataset so the whole walk is testable without a
 * node or DOM. See DESIGN-candidates.md §11.
 */

import type { StateV3 } from "../state";
import {
  assignmentWarning,
  rankAssignmentChoices,
  type SlotRecommendation,
} from "./assignment";
import type { RegionDataset } from "./dataset";
import { pathToAddress } from "./paths";
import {
  resolveZoneRegion,
  type SlotOccupancy,
  type ZoneRegion,
} from "./zone-region";

const SLOT_COUNT = 8;
const MAX_CHAIN = 32;
const ROOT_ID = /^[0-9a-f]{64}$/;
const LETTERS = "abcdefgh";

export interface ZoneView {
  ownerId: string;
  state: StateV3;
}

export type ZoneReader = (ownerId: string) => Promise<ZoneView | null>;

export interface ChainZone {
  ownerId: string;
  /** "" for the root. */
  address: string;
  /** Slots whose entry is null, ascending. */
  freeSlots: number[];
  occupied: number;
}

export interface AssignmentPreview {
  slot: number;
  /** target.address + slot. */
  address: string;
  /** The dataset has this cell. */
  published: boolean;
  warning: string | null;
}

export type MatchResult =
  | {
      kind: "target";
      chain: ChainZone[];
      wantCell: string;
      assigned: AssignmentPreview;
    }
  | { kind: "saturated"; chain: ChainZone[]; reason: "full" | "broken" }
  | { kind: "invalid-root"; reason: string };

/** Exactly one `root` query parameter holding a 64 lowercase-hex id. */
export function parseRootParam(search: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const values = new URLSearchParams(query).getAll("root");
  if (values.length !== 1) return null;
  const value = values[0]!;
  return ROOT_ID.test(value) ? value : null;
}

/** A URL/query with a `root=` parameter, or a bare trimmed 64-hex id. */
export function parseRootInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (ROOT_ID.test(trimmed)) return trimmed;

  let search: string | null = null;
  const question = trimmed.indexOf("?");
  if (question >= 0) {
    search = trimmed.slice(question);
  } else if (trimmed.startsWith("root=")) {
    search = `?${trimmed}`;
  }
  if (search === null) return null;

  const fragment = search.indexOf("#");
  if (fragment >= 0) search = search.slice(0, fragment);
  return parseRootParam(search);
}

/**
 * Reject a malformed id, an unreadable zone, and a zone whose named parent
 * points back at it (a mutual edge means it is a child, not a root). A pending
 * one-sided parent is accepted.
 */
export async function validateRoot(
  read: ZoneReader,
  rootId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!ROOT_ID.test(rootId)) {
    return { ok: false, reason: "the root id must be 64 lowercase hex characters" };
  }

  const view = await read(rootId);
  if (view === null) {
    return { ok: false, reason: `zone ${rootId} is unreadable` };
  }

  const parentId = view.state.parent.userId;
  if (parentId !== null) {
    const parent = await read(parentId);
    if (parent !== null) {
      const pointsBack = parent.state.slots.some(
        (slot) => slot.entry?.contact === rootId,
      );
      if (pointsBack) {
        return {
          ok: false,
          reason: `zone ${rootId} is a child of ${parentId} (mutual parent)`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Walk from the root along the point's published digits and return the first
 * visited zone with a free slot, together with a ranked assignment preview.
 */
export async function findTarget(
  read: ZoneReader,
  dataset: RegionDataset,
  rootId: string,
  point: { lat: number; lng: number },
): Promise<MatchResult> {
  const digits = await publishedDigits(dataset, point);

  let ownerId = rootId;
  let address = "";
  const rootView = await read(ownerId);

  if (rootView === null) {
    return { kind: "invalid-root", reason: `zone ${rootId} is unreadable` };
  }

  let current: ZoneView = rootView;
  const chain: ChainZone[] = [];

  for (;;) {
    const freeSlots = freeSlotIndices(current.state);
    const occupied = SLOT_COUNT - freeSlots.length;
    chain.push({ ownerId: current.ownerId, address, freeSlots, occupied });

    if (freeSlots.length > 0) {
      const assigned = await previewAssignment(
        dataset,
        current.state,
        address,
        digits,
        point,
      );
      return {
        kind: "target",
        chain,
        wantCell: pathToAddress(digits),
        assigned,
      };
    }

    // The zone is full; a target cannot be here, only deeper.
    if (chain.length >= MAX_CHAIN) {
      return { kind: "saturated", chain, reason: "broken" };
    }

    const nextDigit = digits[address.length];
    if (nextDigit !== undefined) {
      // The published path names the child. Only a mutual edge continues.
      const contact = current.state.slots[nextDigit]?.entry?.contact ?? null;
      const child: ZoneView | null = contact === null ? null : await read(contact);
      if (child === null || child.state.parent.userId !== current.ownerId) {
        return { kind: "saturated", chain, reason: "broken" };
      }
      ownerId = child.ownerId;
      address += String(nextDigit);
      current = child;
      continue;
    }

    // Past the published digits: follow the lowest descendable occupied slot.
    let child: ZoneView | null = null;
    let slot = -1;
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      const contact = current.state.slots[index]?.entry?.contact ?? null;
      if (contact === null) continue;
      const candidate = await read(contact);
      if (candidate !== null && candidate.state.parent.userId === current.ownerId) {
        child = candidate;
        slot = index;
        break;
      }
    }
    if (child === null) {
      return { kind: "saturated", chain, reason: "full" };
    }
    ownerId = child.ownerId;
    address += String(slot);
    current = child;
  }
}

async function publishedDigits(
  dataset: RegionDataset,
  point: { lat: number; lng: number },
): Promise<number[]> {
  try {
    const resolved = await dataset.resolve(point.lat, point.lng);
    return [...resolved.row.path];
  } catch {
    // No published cell (or a broken dataset) means no digits at all.
    return [];
  }
}

function freeSlotIndices(state: StateV3): number[] {
  const free: number[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    if (state.slots[slot]?.entry === null) free.push(slot);
  }
  return free;
}

async function previewAssignment(
  dataset: RegionDataset,
  state: StateV3,
  address: string,
  digits: readonly number[],
  point: { lat: number; lng: number },
): Promise<AssignmentPreview> {
  const occupancy: SlotOccupancy[] = Array.from(
    { length: SLOT_COUNT },
    (_, slot) => (state.slots[slot]?.entry === null ? "free" : "taken"),
  );

  let region: ZoneRegion;
  try {
    region = await resolveZoneRegion(dataset, address, occupancy);
  } catch {
    // A provisional/unknown cell is still a valid preview: no dataset row means
    // every child is unpublished. Never let dataset trouble break discovery.
    region = fallbackRegion(address, occupancy);
  }

  const recommendations = rankAssignmentChoices(region, point);
  const nextDigit = digits[address.length];
  let choice: SlotRecommendation | null = null;

  if (nextDigit !== undefined && occupancy[nextDigit] === "free") {
    choice =
      recommendations.find((entry) => entry.child.slot === nextDigit) ?? null;
  }
  if (choice === null) {
    choice = recommendations.find((entry) => entry.free) ?? null;
  }
  if (choice === null) {
    // Defensive: the target has a free slot, so this cannot normally happen.
    const slot = occupancy.findIndex((entry) => entry === "free");
    const child = region.children[slot]!;
    choice = { child, free: true, containsPoint: false, bestFit: false };
  }

  return {
    slot: choice.child.slot,
    address: `${address}${choice.child.slot}`,
    published: !choice.child.provisional,
    warning: assignmentWarning(choice, region, point),
  };
}

function fallbackRegion(
  address: string,
  occupancy: readonly SlotOccupancy[],
): ZoneRegion {
  const children = Array.from({ length: SLOT_COUNT }, (_, slot) => ({
    slot,
    digit: slot,
    letter: LETTERS[slot]!,
    address: `${address}${slot}`,
    row: null,
    ancestor: null,
    provisional: true,
    occupied: occupancy[slot]!,
  }));
  return {
    address,
    root: address === "",
    cell: null,
    ancestor: null,
    provisional: true,
    children,
    freeCount: occupancy.filter((entry) => entry === "free").length,
  };
}
