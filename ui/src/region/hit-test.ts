/**
 * Pure map-click → child-slot hit test for the map page.
 *
 * A zone's children are its eight address digits. Only a child the dataset
 * publishes has a real cell to click: a provisional child is drawn inside its
 * nearest mapped ancestor, so a click on that ancestor cannot tell the eight
 * provisional children apart. Provisional children therefore never win a hit
 * test — they stay list-only.
 *
 * Rows are axis-aligned bounding boxes in degrees (`RegionRow`). Longitudes
 * arrive normalised to [-180, 180), so a click on a repeated world copy or on
 * the antimeridian seam is folded back before testing. A seam row is never
 * treated as wrapping (`minLon` must be <= `maxLon`, which the wire format
 * guarantees); a malformed or ambiguous region returns null rather than a
 * guessed slot.
 */

import { contains, normalizePoint } from "./geo";
import type { MapPoint } from "./map-base";
import type { ChildRegion, ZoneRegion } from "./zone-region";

/**
 * The slot whose published cell contains `point`, or null when no published
 * child does, when the point is invalid, or when the match is ambiguous.
 *
 * Containment is half-open (`[min, max)`), matching `contains` and the assign
 * picker: a point on a shared edge belongs to exactly one sibling. If the
 * half-open pass finds nothing (the outer max edge of the zone), one closed
 * pass is tried; it returns a slot only when exactly one child matches.
 */
export function hitTestCell(
  region: ZoneRegion,
  point: MapPoint,
): number | null {
  if (region === null || region === undefined) return null;
  if (point === null || point === undefined) return null;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  // `normalizePoint` clamps latitude, so reject out-of-world input first.
  if (point.lat < -90 || point.lat > 90) return null;

  const normalized = normalizePoint(point.lat, point.lng);
  if (!Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lng)) {
    return null;
  }

  const published = publishedChildren(region);
  if (published.length === 0) return null;

  const halfOpen = published.filter((child) =>
    contains(child.row!, normalized, false),
  );
  if (halfOpen.length === 1) return halfOpen[0]!.slot;
  if (halfOpen.length > 1) return null;

  const closed = published.filter((child) =>
    contains(child.row!, normalized, true),
  );
  return closed.length === 1 ? closed[0]!.slot : null;
}

/** Children with a usable published row; provisional children are excluded. */
function publishedChildren(region: ZoneRegion): ChildRegion[] {
  const children: unknown = region.children;
  if (!Array.isArray(children)) return [];
  return children.filter((child): child is ChildRegion => {
    if (child === null || child === undefined) return false;
    if (child.provisional === true) return false;
    const row = child.row;
    if (row === null || row === undefined) return false;
    return (
      Number.isFinite(row.minLon) &&
      Number.isFinite(row.maxLon) &&
      Number.isFinite(row.minLat) &&
      Number.isFinite(row.maxLat) &&
      row.minLon <= row.maxLon &&
      row.minLat <= row.maxLat
    );
  });
}
