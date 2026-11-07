/**
 * Slot ranking and admission warnings for region assignment.
 *
 * A zone always has eight assignable slots. When the newcomer's location is
 * known, a free published cell containing it is the ideal choice; otherwise the
 * closest published cell is preferred and provisional cells come last.
 */

import { contains, normalizePoint, type Point } from "./geo";
import type { ChildRegion, ZoneRegion } from "./zone-region";

export interface AssignmentPoint {
  lat: number;
  lng: number;
}

export interface SlotRecommendation {
  child: ChildRegion;
  free: boolean;
  /** False when no point or the child has no published row. */
  containsPoint: boolean;
  /** The first free choice when a point is given and it contains that point. */
  bestFit: boolean;
}

interface Ranked {
  child: ChildRegion;
  containsPoint: boolean;
  distance: number | null;
}

export function rankAssignmentChoices(
  region: ZoneRegion,
  point: AssignmentPoint | null,
): SlotRecommendation[] {
  const normalized = point === null ? null : normalizePoint(point.lat, point.lng);

  const ranked: Ranked[] = region.children.map((child) => ({
    child,
    containsPoint:
      normalized !== null &&
      child.row !== null &&
      contains(child.row, normalized, child.digit === 7),
    distance:
      normalized !== null && child.row !== null
        ? squaredCentreDistance(child.row, normalized)
        : null,
  }));

  const free = ranked
    .filter((entry) => entry.child.occupied === "free")
    .sort((a, b) => compareFree(a, b));
  const occupied = ranked
    .filter((entry) => entry.child.occupied !== "free")
    .sort((a, b) => a.child.slot - b.child.slot);

  const bestFit =
    normalized !== null && free.length > 0 && free[0]!.containsPoint;

  return [...free, ...occupied].map((entry) => ({
    child: entry.child,
    free: entry.child.occupied === "free",
    containsPoint: entry.containsPoint,
    bestFit: bestFit && entry === free[0],
  }));
}

export function assignmentWarning(
  choice: SlotRecommendation | null,
  region: ZoneRegion,
  point: AssignmentPoint | null,
): string | null {
  const normalized = point === null ? null : normalizePoint(point.lat, point.lng);

  if (
    normalized !== null &&
    region.cell !== null &&
    !contains(region.cell, normalized, false)
  ) {
    return "They are outside your region, so none of your cells contains their location.";
  }

  if (choice === null) return null;
  if (!choice.free) return "That slot is already taken.";
  if (choice.child.provisional) {
    return "This cell is provisional, so the map cannot tell whether it contains their location.";
  }
  if (
    normalized !== null &&
    choice.child.row !== null &&
    !contains(choice.child.row, normalized, choice.child.digit === 7)
  ) {
    return "This cell does not contain their location. They can still join, but their region will not match where they are.";
  }
  return null;
}

function compareFree(a: Ranked, b: Ranked): number {
  if (a.containsPoint !== b.containsPoint) return a.containsPoint ? -1 : 1;

  const aPublished = a.child.row !== null;
  const bPublished = b.child.row !== null;
  if (aPublished !== bPublished) return aPublished ? -1 : 1;

  if (a.distance !== null && b.distance !== null && a.distance !== b.distance) {
    return a.distance < b.distance ? -1 : 1;
  }

  const aPopulation = a.child.row?.population ?? 0;
  const bPopulation = b.child.row?.population ?? 0;
  if (aPopulation !== bPopulation) return aPopulation > bPopulation ? -1 : 1;

  return a.child.slot - b.child.slot;
}

function squaredCentreDistance(
  bounds: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  },
  point: Point,
): number {
  const centreLon = (bounds.minLon + bounds.maxLon) / 2;
  const centreLat = (bounds.minLat + bounds.maxLat) / 2;
  const deltaLon = point.lng - centreLon;
  const deltaLat = point.lat - centreLat;
  return deltaLon * deltaLon + deltaLat * deltaLat;
}
