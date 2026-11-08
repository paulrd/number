import countriesTopology from "../assets/countries-110m.json";
import countryAnchors from "../assets/country-labels-110m.json";
import placeRows from "../assets/places-50m-labels.json";

/**
 * Render-agnostic label data for the map. These JSON files are vendored
 * Natural Earth extracts (see `assets/README.md`); nothing here touches the
 * DOM or Leaflet, so the map lane can import this module from its lazy chunk.
 */

export interface PlaceLabel {
  name: string;
  lon: number;
  lat: number;
  rank: number;
}

export interface CountryLabel {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

interface CountryFeature {
  id?: string;
  properties?: { name?: string };
}

interface CountryTopology {
  objects: {
    countries: {
      geometries: CountryFeature[];
    };
  };
}

/** Zoom bands for populated-place labels: z1-2, z3-4, z5-6, z7+. */
const RANK_LIMITS = [0, 1, 2, 3] as const;

function rankLimitForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom < 3) return 0;
  if (zoom < 5) return 1;
  if (zoom < 7) return 2;
  return 3;
}

const ALL_PLACES: readonly PlaceLabel[] = Object.freeze(
  placeRows.map((row) =>
    Object.freeze({
      name: row.name,
      lon: row.lon,
      lat: row.lat,
      rank: row.rank,
    }),
  ),
);

// One precomputed, frozen array per zoom band. Returning the same array keeps
// callers from accidentally mutating shared state and makes LOD changes cheap.
const PLACES_BY_RANK_LIMIT: readonly (readonly PlaceLabel[])[] = RANK_LIMITS.map(
  (limit) => Object.freeze(ALL_PLACES.filter((place) => place.rank <= limit)),
);

/** Every vendored place, in the generator's deterministic order. */
export function placeLabels(): readonly PlaceLabel[] {
  return ALL_PLACES;
}

/**
 * Places visible at `zoom`, filtered by SCALERANK (0 = most prominent).
 * Renderers should still cap the result; this only applies the LOD policy.
 */
export function placeLabelsForZoom(zoom: number): readonly PlaceLabel[] {
  return PLACES_BY_RANK_LIMIT[rankLimitForZoom(zoom)];
}

const anchors = countryAnchors as unknown as Record<
  string,
  readonly [number, number] | undefined
>;

const countryFeatures = (
  countriesTopology as unknown as CountryTopology
).objects.countries.geometries;

const COUNTRY_LABEL_LIST: CountryLabel[] = [];
for (const feature of countryFeatures) {
  const id = feature.id;
  const name = feature.properties?.name;
  const anchor = id ? anchors[id] : undefined;
  if (!id || !name || !anchor) continue;
  COUNTRY_LABEL_LIST.push(
    Object.freeze({ id, name, lon: anchor[0], lat: anchor[1] }),
  );
}

const byNameThenId = (a: CountryLabel, b: CountryLabel): number => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
};

COUNTRY_LABEL_LIST.sort(byNameThenId);

const COUNTRY_LABELS: readonly CountryLabel[] = Object.freeze(
  COUNTRY_LABEL_LIST,
);

const COUNTRY_BY_ID = new Map(
  COUNTRY_LABELS.map((label) => [label.id, label] as const),
);

/**
 * Country name anchors joined with the vendored 110m topology. Features
 * without a numeric ISO id (or without an anchor) are skipped.
 */
export function countryLabels(): readonly CountryLabel[] {
  return COUNTRY_LABELS;
}

/** Look up one country anchor by ISO 3166-1 numeric id, or `null`. */
export function countryLabel(id: string): CountryLabel | null {
  return COUNTRY_BY_ID.get(id) ?? null;
}
