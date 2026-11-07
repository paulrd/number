/**
 * A zone's region: its octal address plus the dataset cells to draw.
 *
 * The zone's own cell is published when the dataset has it; otherwise the
 * nearest published ancestor stands in for display (provisional). Children are
 * always the eight address digits, whether or not the dataset publishes them.
 */

import { SLOT_COUNT } from "../state";
import type { RegionDataset } from "./dataset";
import { addressToPath } from "./paths";
import type { RegionRow } from "./wire";

export type SlotOccupancy = "free" | "taken" | "unconfirmed";

export interface ChildRegion {
  slot: number;
  digit: number;
  letter: string;
  /** Parent address + String(slot); a root child is just the digit. */
  address: string;
  /** Published child row, else null. */
  row: RegionRow | null;
  /** Published cell to draw for this child (row, else the zone's ancestor). */
  ancestor: RegionRow | null;
  provisional: boolean;
  occupied: SlotOccupancy;
}

export interface ZoneRegion {
  address: string;
  root: boolean;
  /** The zone's own published cell; null for root or provisional. */
  cell: RegionRow | null;
  /** Nearest published cell used for display. */
  ancestor: RegionRow | null;
  /** Own address has no published row. */
  provisional: boolean;
  /** Always length 8, slot order 0..7. */
  children: ChildRegion[];
  /** Children with occupied === "free". */
  freeCount: number;
}

const LETTERS = "abcdefgh";

export async function resolveZoneRegion(
  dataset: RegionDataset,
  address: string,
  slots: ReadonlyArray<SlotOccupancy>,
): Promise<ZoneRegion> {
  const path = addressToPath(address);
  if (slots.length !== SLOT_COUNT) {
    throw new Error(
      `zone "${address}" needs exactly ${SLOT_COUNT} slot entries, got ${slots.length}`,
    );
  }

  const root = address === "";
  let cell: RegionRow | null = null;
  let ancestor: RegionRow | null = null;
  let provisional = false;

  if (!root) {
    const own = await dataset.lookupRow(path);
    if (own) {
      cell = own;
      ancestor = own;
    } else {
      provisional = true;
      const published = await dataset.nearestPublishedAncestor(path);
      ancestor = published?.row ?? null;
    }
  }

  const children: ChildRegion[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const row = await dataset.lookupRow([...path, slot]);
    children.push({
      slot,
      digit: slot,
      letter: LETTERS[slot]!,
      address: `${address}${slot}`,
      row,
      ancestor: row ?? ancestor,
      provisional: row === null,
      occupied: slots[slot] ?? "free",
    });
  }

  return {
    address,
    root,
    cell,
    ancestor,
    provisional,
    children,
    freeCount: children.filter((child) => child.occupied === "free").length,
  };
}
