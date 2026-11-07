/** Point and bounds helpers for the region picker. */

export interface Point {
  lat: number;
  lng: number;
}

export interface Bounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** Clamp latitude; wrap longitude into [-180, 180). */
export function normalizePoint(lat: number, lng: number): Point {
  const clampedLat = Math.max(-90, Math.min(90, lat));
  const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat: clampedLat, lng: wrappedLng };
}

/**
 * Half-open containment: `[min, max)`, except the numerically highest child,
 * which includes its max edges. The dataset's children tile the parent, so
 * exactly one child matches a point.
 */
export function contains(
  bounds: Bounds,
  point: Point,
  includeMax: boolean,
): boolean {
  const latInside =
    point.lat >= bounds.minLat &&
    (point.lat < bounds.maxLat ||
      (includeMax && point.lat <= bounds.maxLat));
  const lngInside =
    point.lng >= bounds.minLon &&
    (point.lng < bounds.maxLon ||
      (includeMax && point.lng <= bounds.maxLon));
  return latInside && lngInside;
}
