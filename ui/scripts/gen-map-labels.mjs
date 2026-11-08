#!/usr/bin/env node
/**
 * One-off developer tool. NOT part of `npm run build`, `tsc`, or `vite build`;
 * nothing in `src/` imports it. Run it by hand when refreshing the vendored
 * label assets:
 *
 *   node scripts/gen-map-labels.mjs
 *   node scripts/gen-map-labels.mjs \
 *     --countries /tmp/ne_110m_admin_0_countries.geojson \
 *     --places /tmp/ne_50m_populated_places_simple.geojson
 *
 * By default it downloads the Natural Earth GeoJSON from the upstream GitHub
 * mirror (public domain). Supplying local paths keeps an offline refresh
 * possible. Either way the output is deterministic for a given input.
 *
 * Outputs (compact JSON, newline-terminated):
 *   src/assets/country-labels-110m.json  { "<iso_n3>": [lon, lat] }
 *   src/assets/places-50m-labels.json    [{ name, lon, lat, rank }]
 *
 * Normalisation:
 *   - country keys are the exact 3-digit ISO 3166-1 numeric strings used by
 *     the vendored `countries-110m.json`; `ISO_N3_EH` is used when `ISO_N3`
 *     is Natural Earth's `-99` placeholder (France, Norway). Only ids present
 *     in the vendored topology are emitted, so the loader never sees extras.
 *   - places keep Natural Earth `scalerank` as `rank` (0 = most prominent) and
 *     only rows with rank <= 3 are kept.
 *   - lon/lat are rounded to 3 decimals; unusable rows are dropped.
 *   - duplicate place names are collapsed to the most prominent row so the
 *     map never renders the same label twice (Natural Earth has a few).
 *   - country ids sort ascending; places sort by descending rank then name.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSETS = resolve(HERE, "../src/assets");

const DEFAULT_COUNTRIES_SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const DEFAULT_PLACES_SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson";

const COUNTRY_OUTPUT = "country-labels-110m.json";
const PLACES_OUTPUT = "places-50m-labels.json";
const MAX_PLACE_RANK = 3;

function parseArgs(argv) {
  const options = {
    countries: DEFAULT_COUNTRIES_SOURCE,
    places: DEFAULT_PLACES_SOURCE,
    vendored: resolve(DEFAULT_ASSETS, "countries-110m.json"),
    outDir: DEFAULT_ASSETS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--countries":
        options.countries = next();
        break;
      case "--places":
        options.places = next();
        break;
      case "--vendored":
        options.vendored = next();
        break;
      case "--out-dir":
        options.outDir = next();
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: node scripts/gen-map-labels.mjs [options]",
            "  --countries <path|url>  admin-0 countries GeoJSON (default: upstream master)",
            "  --places <path|url>     populated places GeoJSON (default: upstream master)",
            "  --vendored <path>       vendored countries-110m.json (default: src/assets)",
            "  --out-dir <path>        output directory (default: src/assets)",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function loadJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`${source} -> HTTP ${response.status}`);
    }
    return response.json();
  }
  return JSON.parse(await readFile(resolve(source), "utf8"));
}

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function validLonLat(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

function vendoredFeatures(vendored) {
  const geometries = vendored?.objects?.countries?.geometries;
  if (!Array.isArray(geometries)) {
    throw new Error("vendored file has no objects.countries.geometries");
  }
  return geometries;
}

function buildCountryAnchors(countriesGeo, features) {
  const anchorsById = new Map();
  for (const feature of countriesGeo.features ?? []) {
    const p = feature.properties ?? {};
    const lon = Number(p.LABEL_X);
    const lat = Number(p.LABEL_Y);
    if (!validLonLat(lon, lat)) continue;

    let iso = String(p.ISO_N3 ?? "").trim();
    if (!/^\d{3}$/.test(iso) || iso === "-99") {
      iso = String(p.ISO_N3_EH ?? "").trim();
    }
    if (!/^\d{3}$/.test(iso) || iso === "-99") continue;

    // Natural Earth has one row per country; first wins if that ever changes.
    if (!anchorsById.has(iso)) {
      anchorsById.set(iso, [round3(lon), round3(lat)]);
    }
  }

  const numericFeatures = features.filter((f) => /^\d{3}$/.test(f.id ?? ""));
  const numericIds = [...new Set(numericFeatures.map((f) => f.id))].sort(cmp);
  const anchors = {};
  const ids = [];
  const missing = [];
  for (const id of numericIds) {
    const anchor = anchorsById.get(id);
    if (anchor) {
      anchors[id] = anchor;
      ids.push(id);
    } else {
      const feature = numericFeatures.find((f) => f.id === id);
      missing.push({ id, name: feature?.properties?.name ?? "(unnamed)" });
    }
  }

  const withoutNumericId = features
    .filter((f) => !/^\d{3}$/.test(f.id ?? ""))
    .map((f) => f.properties?.name ?? "(unnamed)");

  return { anchors, ids, missing, withoutNumericId };
}

function buildPlaces(placesGeo) {
  const rows = [];
  for (const feature of placesGeo.features ?? []) {
    const p = feature.properties ?? {};
    const rank = Number(p.SCALERANK ?? p.scalerank);
    if (!Number.isInteger(rank) || rank < 0 || rank > MAX_PLACE_RANK) continue;

    const name = String(p.name ?? p.NAME ?? "").trim();
    const lon = Number(p.longitude ?? p.LONGITUDE);
    const lat = Number(p.latitude ?? p.LATITUDE);
    if (!name || !validLonLat(lon, lat)) continue;

    rows.push({ name, lon: round3(lon), lat: round3(lat), rank });
  }

  // Deduplicate by exact name, keeping the most prominent point. Natural Earth
  // has a handful of same-named places (Valencia, Hyderabad, Victoria).
  rows.sort(
    (a, b) =>
      a.rank - b.rank ||
      cmp(a.name, b.name) ||
      a.lon - b.lon ||
      a.lat - b.lat,
  );
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    unique.push(row);
  }

  // Requested deterministic order: descending SCALERANK, then name.
  unique.sort(
    (a, b) =>
      b.rank - a.rank ||
      cmp(a.name, b.name) ||
      a.lon - b.lon ||
      a.lat - b.lat,
  );

  return { places: unique, collapsed: rows.length - unique.length };
}

function byteSize(value) {
  return Buffer.byteLength(value, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log(`countries source: ${options.countries}`);
  console.log(`places source:    ${options.places}`);

  const [countriesGeo, placesGeo, vendored] = await Promise.all([
    loadJson(options.countries),
    loadJson(options.places),
    loadJson(options.vendored),
  ]);

  const features = vendoredFeatures(vendored);
  const { anchors, ids, missing, withoutNumericId } = buildCountryAnchors(
    countriesGeo,
    features,
  );
  const { places, collapsed } = buildPlaces(placesGeo);

  // Serialize by hand: JSON.stringify would enumerate integer-like keys
  // ("100", ...) before keys with leading zeros ("004"), not sorted order.
  const countryJson = `{${ids
    .map((id) => `${JSON.stringify(id)}:${JSON.stringify(anchors[id])}`)
    .join(",")}}\n`;
  const placesJson = `${JSON.stringify(places)}\n`;

  await Promise.all([
    writeFile(resolve(options.outDir, COUNTRY_OUTPUT), countryJson),
    writeFile(resolve(options.outDir, PLACES_OUTPUT), placesJson),
  ]);

  const rankCounts = new Map();
  for (const place of places) {
    rankCounts.set(place.rank, (rankCounts.get(place.rank) ?? 0) + 1);
  }

  console.log(
    `${COUNTRY_OUTPUT}: ${ids.length} anchors, ${byteSize(countryJson)} bytes`,
  );
  console.log(
    `${PLACES_OUTPUT}: ${places.length} labels (${collapsed} duplicate names collapsed), ${byteSize(placesJson)} bytes`,
  );
  console.log(
    `  ranks: ${[...rankCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([rank, count]) => `${rank}=${count}`)
      .join(", ")}`,
  );
  if (missing.length > 0) {
    console.log(
      `  missing anchors (${missing.length}): ${missing
        .map(({ id, name }) => `${id} ${name}`)
        .join(", ")}`,
    );
  }
  if (withoutNumericId.length > 0) {
    console.log(
      `  vendored features without a numeric id (${withoutNumericId.length}): ${withoutNumericId.join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
