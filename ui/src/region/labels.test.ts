import { describe, expect, it } from "vitest";
import countryAnchors from "../assets/country-labels-110m.json";
import countriesTopology from "../assets/countries-110m.json";
import placeRows from "../assets/places-50m-labels.json";
import {
  countryLabel,
  countryLabels,
  placeLabels,
  placeLabelsForZoom,
  type PlaceLabel,
} from "./labels";

interface CountryFeature {
  id?: string;
  properties?: { name?: string };
}

const countryFeatures = (
  countriesTopology as unknown as {
    objects: { countries: { geometries: CountryFeature[] } };
  }
).objects.countries.geometries;

const featureById = new Map<string, CountryFeature>();
for (const feature of countryFeatures) {
  if (feature.id) featureById.set(feature.id, feature);
}

function keyOf(place: PlaceLabel): string {
  return `${place.name}|${place.lon}|${place.lat}|${place.rank}`;
}

describe("populated place labels", () => {
  it("keeps a plausible SCALERANK <= 3 subset", () => {
    const places = placeLabels();
    expect(places.length).toBeGreaterThanOrEqual(450);
    expect(places.length).toBeLessThanOrEqual(520);
  });

  it("has usable names, coordinates and ranks", () => {
    for (const place of placeLabels()) {
      expect(place.name.trim().length).toBeGreaterThan(0);
      expect(place.lon).toBeGreaterThanOrEqual(-180);
      expect(place.lon).toBeLessThanOrEqual(180);
      expect(place.lat).toBeGreaterThanOrEqual(-90);
      expect(place.lat).toBeLessThanOrEqual(90);
      expect(Number.isInteger(place.rank)).toBe(true);
      expect(place.rank).toBeGreaterThanOrEqual(0);
      expect(place.rank).toBeLessThanOrEqual(3);
    }
  });

  it("has unique, non-empty names", () => {
    const names = placeLabels().map((place) => place.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("applies the zoom LOD policy monotonically", () => {
    const z2 = placeLabelsForZoom(2);
    const z4 = placeLabelsForZoom(4);
    const z6 = placeLabelsForZoom(6);
    const z8 = placeLabelsForZoom(8);

    expect(z2.length).toBeLessThan(z4.length);
    expect(z4.length).toBeLessThan(z6.length);
    expect(z6.length).toBeLessThan(z8.length);
    expect(z8.length).toBe(placeLabels().length);

    expect(z2.every((place) => place.rank === 0)).toBe(true);
    expect(z4.every((place) => place.rank <= 1)).toBe(true);
    expect(z6.every((place) => place.rank <= 2)).toBe(true);
    expect(z8.every((place) => place.rank <= 3)).toBe(true);

    const keys = (places: readonly PlaceLabel[]) =>
      new Set(places.map((place) => keyOf(place)));
    const z2Keys = keys(z2);
    const z4Keys = keys(z4);
    const z6Keys = keys(z6);
    const z8Keys = keys(z8);
    for (const key of z2Keys) expect(z4Keys.has(key)).toBe(true);
    for (const key of z4Keys) expect(z6Keys.has(key)).toBe(true);
    for (const key of z6Keys) expect(z8Keys.has(key)).toBe(true);
  });

  it("is stable across calls and ignores non-finite zoom", () => {
    expect(placeLabelsForZoom(8)).toBe(placeLabelsForZoom(8));
    expect(placeLabelsForZoom(0).map(keyOf)).toEqual(
      placeLabelsForZoom(2).map(keyOf),
    );
    expect(placeLabelsForZoom(Number.NaN).map(keyOf)).toEqual(
      placeLabelsForZoom(2).map(keyOf),
    );
    expect(placeLabels()).toBe(placeLabels());
  });
});

describe("country label anchors", () => {
  it("joins every vendored feature that has an anchor", () => {
    const labels = countryLabels();
    expect(labels.length).toBeGreaterThanOrEqual(170);

    for (const label of labels) {
      const feature = featureById.get(label.id);
      expect(feature).toBeDefined();
      expect(feature?.properties?.name).toBe(label.name);
      expect(label.lon).toBeGreaterThanOrEqual(-180);
      expect(label.lon).toBeLessThanOrEqual(180);
      expect(label.lat).toBeGreaterThanOrEqual(-90);
      expect(label.lat).toBeLessThanOrEqual(90);
    }
  });

  it("sorts by name", () => {
    const names = countryLabels().map((label) => label.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("returns a known country and null for an unknown id", () => {
    expect(countryLabel("008")).toEqual({
      id: "008",
      name: "Albania",
      lon: 20.114,
      lat: 40.655,
    });
    expect(countryLabel("999")).toBeNull();
    expect(countryLabel("not-a-country")).toBeNull();
  });
});

describe("vendored label JSON", () => {
  it("parses and is not empty", () => {
    expect(Array.isArray(placeRows)).toBe(true);
    expect(placeRows.length).toBeGreaterThan(0);
    expect(Object.keys(countryAnchors).length).toBeGreaterThan(0);
    expect(countryFeatures.length).toBeGreaterThan(0);
  });
});
