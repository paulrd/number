/**
 * The region a candidate would get from the parent it is about to sign.
 *
 * The parent writes the child slot before the candidate signs `parent`; that
 * slot write is the region designation. This module is purely presentational:
 * it turns a readable parent snapshot and the parent's settled address into the
 * prospective child address, without changing what the save flow does.
 */
import type { BoardSnapshot } from "./board";
import { childSlotIndex, type AddressInfo } from "./tree-view";

export type ParentRegionProblem =
  | "no-parent"
  | "unreadable"
  | "unsettled-parent"
  | "no-slot"
  | null;

export interface ProspectiveRegion {
  /** Parent address + slot digit. */
  address: string | null;
  /** Zero-based slot index. */
  slot: number | null;
  /** String(slot); the address digit. */
  digit: string | null;
  /** "abcdefgh"[slot]. */
  cellLetter: string | null;
  problem: ParentRegionProblem;
}

const CELL_LETTERS = "abcdefgh";

function emptyRegion(problem: ParentRegionProblem): ProspectiveRegion {
  return {
    address: null,
    slot: null,
    digit: null,
    cellLetter: null,
    problem,
  };
}

/**
 * Resolve the prospective region from the selected parent.
 *
 * `no-parent` means the dialog has no readable own id to look for; `unreadable`
 * means the parent board itself could not be read. `unsettled-parent` covers a
 * parent whose own address chain is not resolved (pending, missing, looping, or
 * unreadable ancestor). `no-slot` means the parent has not assigned this zone a
 * region yet. Never throws.
 */
export function prospectiveRegion(
  parent: BoardSnapshot | null,
  parentAddress: AddressInfo,
  ownId: string | null,
): ProspectiveRegion {
  if (ownId === null) return emptyRegion("no-parent");
  if (parent === null) return emptyRegion("unreadable");
  if (parentAddress.address === null) {
    return emptyRegion("unsettled-parent");
  }

  let slot: number | null = null;
  try {
    slot = childSlotIndex(parent.state, ownId);
  } catch {
    slot = null;
  }
  if (slot === null || slot < 0 || slot >= CELL_LETTERS.length) {
    return emptyRegion("no-slot");
  }

  return {
    address: `${parentAddress.address}${slot}`,
    slot,
    digit: String(slot),
    cellLetter: CELL_LETTERS[slot],
    problem: null,
  };
}
