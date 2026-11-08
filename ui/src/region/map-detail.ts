/**
 * DOM-free helpers for the map's detail layers.
 *
 * `map-base.ts` owns Leaflet and the DOM; everything that can be reasoned
 * about without a browser lives here so the zoom bands, collision rules and
 * ring paths are unit-testable in the node test environment.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelCandidate extends Box {
  id: string;
  text: string;
  /** Lower is more important. City rank first, then countries. */
  rank: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface SelectLabelOptions {
  cap?: number;
  /** Extra space required between boxes. */
  padding?: number;
  /** Boxes already placed (for example, city labels). */
  occupied?: readonly Box[];
}

export interface GraticuleSpec {
  step: number;
  parallels: readonly number[];
  meridians: readonly number[];
}

/**
 * Zoom at which a `full` map swaps the 110m world for the 1:50m countries.
 * `compact` maps never swap, whatever the zoom.
 */
export const DETAIL_WORLD_MIN_ZOOM = 5;

export function detailedWorldForZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= DETAIL_WORLD_MIN_ZOOM;
}

/** 30° at world zoom, 10° in the middle, 5° near the detail ceiling, none above. */
export function graticuleStepForZoom(zoom: number): number | null {
  if (!Number.isFinite(zoom)) return 30;
  if (zoom <= 3) return 30;
  if (zoom <= 5) return 10;
  if (zoom <= 7) return 5;
  return null;
}

export function graticuleValues(step: number): {
  parallels: number[];
  meridians: number[];
} {
  const parallels: number[] = [];
  const meridians: number[] = [];
  if (!Number.isFinite(step) || step <= 0) return { parallels, meridians };

  // Skip the poles: meridians are drawn to ±85° anyway.
  for (let lat = -90 + step; lat < 90; lat += step) {
    if (Math.abs(lat) < 85) parallels.push(round(lat));
  }
  for (let lng = -180; lng < 180; lng += step) {
    meridians.push(round(lng));
  }
  return { parallels, meridians };
}

export function graticuleForZoom(zoom: number): GraticuleSpec | null {
  const step = graticuleStepForZoom(zoom);
  if (step === null) return null;
  const { parallels, meridians } = graticuleValues(step);
  return { step, parallels, meridians };
}

/**
 * Conservative text width for collision. The estimate is intentionally a
 * little wide: a label may not overlap even when the real glyphs are narrower.
 */
export function labelWidth(
  text: string,
  fontSizePx: number,
  uppercase = false,
): number {
  const factor = uppercase ? 0.68 : 0.62;
  return Math.ceil(text.length * fontSizePx * factor + 8);
}

export function labelHeight(fontSizePx: number): number {
  return Math.ceil(fontSizePx * 1.35);
}

/** Country names need a real screen area, not just a zoom gate. */
export function countryLabelVisible(zoom: number, areaPx: number): boolean {
  return Number.isFinite(zoom) && zoom >= 3 && areaPx >= 900;
}

export function boxesOverlap(a: Box, b: Box, padding = 0): boolean {
  return (
    a.x < b.x + b.width + padding &&
    a.x + a.width + padding > b.x &&
    a.y < b.y + b.height + padding &&
    a.y + a.height + padding > b.y
  );
}

export function boxInViewport(box: Box, viewport: Viewport): boolean {
  return (
    box.x + box.width > 0 &&
    box.x < viewport.width &&
    box.y + box.height > 0 &&
    box.y < viewport.height
  );
}

/**
 * Greedy, deterministic placement: most important first, then text/id so two
 * runs with the same data always keep the same labels. A label that does not
 * fit is dropped; the sidebar remains the full record.
 */
export function selectLabels<T extends LabelCandidate>(
  candidates: readonly T[],
  viewport: Viewport,
  options: SelectLabelOptions = {},
): T[] {
  const cap = options.cap ?? Number.POSITIVE_INFINITY;
  const padding = options.padding ?? 2;
  const occupied: Box[] = [...(options.occupied ?? [])];
  const sorted = [...candidates].sort(
    (a, b) =>
      a.rank - b.rank ||
      compareText(a.text, b.text) ||
      compareText(a.id, b.id),
  );

  const selected: T[] = [];
  for (const candidate of sorted) {
    if (selected.length >= cap) break;
    if (!boxInViewport(candidate, viewport)) continue;
    if (occupied.some((box) => boxesOverlap(candidate, box, padding))) continue;
    selected.push(candidate);
    occupied.push(candidate);
  }
  return selected;
}

/**
 * Ancestor paths to outline, nearest first: parent, then grandparent. The own
 * path and the world root are never returned, so a ring can never invent a
 * cell at or below the current one.
 */
export function ancestorPaths(path: readonly number[]): number[][] {
  const paths: number[][] = [];
  for (const keep of [path.length - 1, path.length - 2]) {
    if (keep > 0) paths.push(path.slice(0, keep));
  }
  return paths;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
