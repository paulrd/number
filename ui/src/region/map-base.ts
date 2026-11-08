/**
 * The one Leaflet stage used by the region picker dialog, the map page and the
 * onboarding panel.
 *
 * Leaflet, its CSS, and the vendored country geometry live here and only here,
 * so every caller loads the same lazy chunk instead of carrying its own copy.
 * The map is decorative: no keyboard handler, no zoom control, no attribution
 * control and no tile layer. Callers supply an accessible list or form as the
 * equal path and keep the element `aria-hidden`.
 *
 * Detail (`detail: "full"`) adds a graticule, country names and zoom-gated
 * city labels, plus faint ancestor rings around a zone's own cell. Above zoom
 * 5 it also swaps the 110m world for a lazily imported 1:50m layer. The label
 * and geometry chunks are separate; `compact` (onboarding) loads neither and
 * keeps the plain 110m world. Every detail rebuild is throttled and reports
 * its own render time in a `map-detail` DOM event on the container.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries from "../assets/countries-110m.json";
import type { CountryLabel, PlaceLabel } from "./labels";
import {
  ancestorPaths,
  boxesOverlap,
  countryLabelVisible,
  detailedWorldForZoom,
  graticuleForZoom,
  labelHeight,
  labelWidth,
  selectLabels,
  type Box,
  type LabelCandidate,
} from "./map-detail";
import type { RegionRow } from "./wire";

const WORLD_VIEW: L.LatLngExpression = [20, 0];
const WORLD_ZOOM = 1;
const DEFAULT_MAX_ZOOM = 11;
const CITY_LABEL_CAP = 40;
const COUNTRY_LABEL_CAP = 20;
const LABEL_DEBOUNCE_MS = 60;

export type MapDetail = "compact" | "full";

export interface MapPoint {
  lat: number;
  lng: number;
}

export interface MapStageOptions {
  /** "compact" for the onboarding embed, "full" for the page. */
  detail?: MapDetail;
  /** Defaults to 11; onboarding passes 8 to keep its small viewport readable. */
  maxZoom?: number;
  /** Extra class on the country paths, for per-surface styling. */
  countryClassName?: string;
  /** Replaces the default country path style when supplied. */
  countryStyle?: L.PathOptions;
  /** Map clicks. The page uses this for the place tab; the dialog for assign. */
  onClick?: (point: MapPoint) => void;
  /**
   * Inline-assignment seam. `hitTestCell` maps a click to a slot; when it
   * returns a slot, `onSelectCell` reports it. Both must be supplied to enable
   * click-to-select.
   */
  hitTestCell?: (point: MapPoint) => number | null;
  onSelectCell?: (slot: number) => void;
}

export interface FitOptions {
  /** Include this point in the fit. */
  point?: MapPoint | null;
  padding?: [number, number];
  maxZoom?: number;
}

export interface MapStage {
  readonly detail: MapDetail;
  readonly map: L.Map;
  /** Call after showing a map created while hidden. */
  invalidate(): void;
  /** Remove the Leaflet instance. The DOM element stays for a later create. */
  destroy(): void;
  clear(): void;
  addCell(row: RegionRow, className: string): void;
  addLabel(
    row: RegionRow,
    text: string,
    className: string,
    size?: [number, number],
  ): void;
  addPoint(point: MapPoint, className?: string, radius?: number): void;
  /** Draw the highlight for the selected cell (inline-assignment lane). */
  drawSelection(row: RegionRow): void;
  fitRows(rows: readonly RegionRow[], options?: FitOptions): void;
  setWorld(): void;
  setView(point: MapPoint, zoom: number): void;
  zoomIn(): void;
  zoomOut(): void;
}

interface LatLonBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

interface CountryFeature {
  id?: string | number;
  geometry?: unknown;
}

interface PositionedLabel extends LabelCandidate {
  lat: number;
  lng: number;
}

export function createMapStage(
  element: HTMLElement,
  options: MapStageOptions = {},
): MapStage {
  const detail = options.detail ?? "full";
  const detailed = detail === "full";
  const map = L.map(element, {
    crs: L.CRS.EPSG4326,
    center: WORLD_VIEW,
    zoom: WORLD_ZOOM,
    minZoom: 1,
    maxZoom: options.maxZoom ?? DEFAULT_MAX_ZOOM,
    worldCopyJump: true,
    attributionControl: false,
    // The list and the coordinate form are the keyboard path; keep every
    // Leaflet control out of the tab order.
    keyboard: false,
    zoomControl: false,
  });
  element.removeAttribute("tabindex");

  const topology = countries as unknown as Topology<{
    countries: GeometryCollection;
  }>;
  // Exactly once per stage; a zoom never rebuilds the topology or these paths.
  const geometry = feature(topology, topology.objects.countries);
  const worldStyle = (): L.PathOptions =>
    ({
      className: options.countryClassName ?? "map-world",
      ...(options.countryStyle ?? {}),
    }) as L.PathOptions;

  // The 110m world ships in the base chunk and is visible by default. A full
  // map swaps it for the lazy 1:50m layer above zoom 5; compact never does.
  const world110Layer = L.geoJSON(
    geometry as unknown as GeoJSON.GeoJsonObject,
    { style: worldStyle, interactive: false },
  ).addTo(map);
  world110Layer.bringToBack();
  element.dataset.detail = detailed ? "110m" : "compact";

  const graticuleLayer = L.layerGroup().addTo(map);
  const cellLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);

  const animate = !prefersReducedMotion();
  let destroyed = false;
  /** Bumped by clear(); async rings and labels compare it before drawing. */
  let drawGeneration = 0;
  let graticuleTimer: number | null = null;
  let labelTimer: number | null = null;
  let labelsReady = false;
  let placesForZoom: ((zoom: number) => readonly PlaceLabel[]) | null = null;
  let countryList: readonly CountryLabel[] = [];
  const countryBounds = new Map<string, LatLonBounds>();
  let countryBoundsReady = false;
  let lastCountryCount = 0;
  let lastGraticuleMs = 0;
  let activeWorld: "110m" | "50m" = "110m";
  /** Parsed once, kept after switching back, so re-entering the band is instant. */
  let world50Layer: L.GeoJSON | null = null;
  let world50Loading = false;
  /** Previous zoomend band, so a failed import retries on the next crossing. */
  let detailedZoom = detailedWorldForZoom(map.getZoom());

  if (detailed) {
    buildCountryBounds();
    renderGraticule();
    void loadLabels();
  }

  function onZoomEnd(): void {
    if (!detailed || destroyed) return;
    syncWorldForZoom();
    scheduleGraticule();
    scheduleLabels();
  }

  /**
   * Single lazy import. A failed load leaves 110m in place and quietly retries
   * on the next crossing of the threshold; nothing here blocks clicks.
   */
  function loadDetailedWorld(): void {
    if (world50Loading || world50Layer !== null || destroyed) return;
    world50Loading = true;
    element.dataset.detail = "loading";
    // Static specifier: Vite emits countries-50m.json as its own lazy chunk.
    void import("../assets/countries-50m.json")
      .then((module) => {
        world50Loading = false;
        if (destroyed) return;
        const topology50 = module.default as unknown as Topology<{
          countries: GeometryCollection;
        }>;
        const geometry50 = feature(
          topology50,
          topology50.objects.countries,
        ) as unknown as GeoJSON.GeoJsonObject;
        world50Layer = L.geoJSON(geometry50, {
          style: worldStyle,
          interactive: false,
        });
        if (detailedWorldForZoom(map.getZoom())) {
          showWorld(world50Layer, "50m");
        } else {
          // The view left the band while the chunk loaded; keep it parsed.
          element.dataset.detail = "110m";
        }
      })
      .catch(() => {
        world50Loading = false;
        if (destroyed) return;
        element.dataset.detail = "110m";
      });
  }

  function showWorld(layer: L.GeoJSON, kind: "110m" | "50m"): void {
    if (destroyed) return;
    const current = activeWorld === "50m" ? world50Layer : world110Layer;
    if (current !== null && current !== layer) map.removeLayer(current);
    if (!map.hasLayer(layer)) layer.addTo(map);
    // Beneath the graticule and both cell layers.
    layer.bringToBack();
    activeWorld = kind;
    element.dataset.detail = kind;
  }

  function syncWorldForZoom(): void {
    const wantDetailed = detailedWorldForZoom(map.getZoom());
    const crossed = wantDetailed !== detailedZoom;
    detailedZoom = wantDetailed;
    if (wantDetailed) {
      if (world50Layer !== null) {
        if (activeWorld !== "50m") showWorld(world50Layer, "50m");
      } else if (crossed) {
        loadDetailedWorld();
      }
    } else if (activeWorld === "50m") {
      showWorld(world110Layer, "110m");
    } else if (element.dataset.detail === "loading") {
      // Left the band mid-load; the parsed layer can wait for the next crossing.
      element.dataset.detail = "110m";
    }
  }

  map.on("zoomend", onZoomEnd);
  map.on("moveend", () => {
    if (!detailed || destroyed) return;
    scheduleLabels();
    scheduleGraticule();
  });

  // One click path for both surfaces: the page resolves a place on the place
  // tab (`onClick`) and selects a child on the zone tab (`hitTestCell` +
  // `onSelectCell`). Leaflet already suppresses `click` after a drag.
  map.on("click", (event: L.LeafletMouseEvent) => {
    if (destroyed) return;
    const point: MapPoint = { lat: event.latlng.lat, lng: event.latlng.lng };
    options.onClick?.(point);
    if (options.hitTestCell !== undefined && options.onSelectCell !== undefined) {
      const slot = options.hitTestCell(point);
      if (slot !== null) options.onSelectCell(slot);
    }
  });

  function scheduleGraticule(): void {
    if (graticuleTimer !== null) return;
    graticuleTimer = window.setTimeout(() => {
      graticuleTimer = null;
      renderGraticule();
    }, LABEL_DEBOUNCE_MS);
  }

  function scheduleLabels(): void {
    if (!labelsReady || destroyed) return;
    if (labelTimer !== null) window.clearTimeout(labelTimer);
    labelTimer = window.setTimeout(() => {
      labelTimer = null;
      renderLabels();
    }, LABEL_DEBOUNCE_MS);
  }

  function loadLabels(): void {
    // Separate chunk: compact maps and the initial bundle never load it.
    void import("./labels")
      .then((module) => {
        if (destroyed) return;
        placesForZoom = module.placeLabelsForZoom;
        countryList = module.countryLabels();
        labelsReady = true;
        scheduleLabels();
      })
      .catch(() => {
        // Graticule still works; the sidebar is unaffected.
        labelsReady = false;
      });
  }

  function buildCountryBounds(): void {
    if (countryBoundsReady) return;
    countryBoundsReady = true;
    const collection = geometry as unknown as {
      features?: readonly CountryFeature[];
    };
    for (const item of collection.features ?? []) {
      if (item.id === undefined || item.geometry === undefined) continue;
      const bounds = boundsOfGeometry(item.geometry);
      if (bounds) countryBounds.set(String(item.id), bounds);
    }
  }

  function renderGraticule(): void {
    const started = performance.now();
    graticuleLayer.clearLayers();
    const spec = graticuleForZoom(map.getZoom());
    if (spec === null) {
      lastGraticuleMs = performance.now() - started;
      return;
    }

    // Clip to the visible span: a world view draws every line, but a zoomed
    // view draws only the few that cross it (105 global lines at z7 would be
    // pure DOM cost for two visible ones).
    const bounds = map.getBounds();
    const west = Math.max(-180, bounds.getWest());
    const east = Math.min(180, bounds.getEast());
    const south = Math.max(-85, bounds.getSouth());
    const north = Math.min(85, bounds.getNorth());
    const fullWorld = east <= west || map.getZoom() <= 2;

    for (const lat of spec.parallels) {
      if (lat < south || lat > north) continue;
      L.polyline(
        [
          [lat, fullWorld ? -180 : west],
          [lat, fullWorld ? 180 : east],
        ],
        {
          className: `map-graticule${lat === 0 ? " map-graticule--strong" : ""}`,
          interactive: false,
          weight: 1,
        },
      ).addTo(graticuleLayer);
    }
    for (const lng of spec.meridians) {
      if (!fullWorld && (lng < west || lng > east)) continue;
      L.polyline(
        [
          [fullWorld ? -85 : south, lng],
          [fullWorld ? 85 : north, lng],
        ],
        {
          className: `map-graticule${lng === 0 ? " map-graticule--strong" : ""}`,
          interactive: false,
          weight: 1,
        },
      ).addTo(graticuleLayer);
    }
    lastGraticuleMs = performance.now() - started;
  }

  function renderLabels(): void {
    const started = performance.now();
    labelLayer.clearLayers();
    lastCountryCount = 0;
    if (!labelsReady || placesForZoom === null) return;

    const zoom = map.getZoom();
    const size = map.getSize();
    const viewport = { width: size.x, height: size.y };
    const cities = selectLabels(projectPlaces(placesForZoom(zoom)), viewport, {
      cap: CITY_LABEL_CAP,
    });
    addLabelMarkers(cities, "map-place-label");

    const countryCandidates = projectCountries(zoom, viewport, cities);
    const countries = selectLabels(countryCandidates, viewport, {
      cap: COUNTRY_LABEL_CAP,
      occupied: cities as readonly Box[],
    });
    lastCountryCount = countries.length;
    addLabelMarkers(countries, "map-country-label");

    const ms = performance.now() - started;
    element.dispatchEvent(
      new CustomEvent("map-detail", {
        detail: {
          ms,
          zoom,
          places: cities.length,
          countries: lastCountryCount,
          graticuleMs: lastGraticuleMs,
          step: graticuleForZoom(zoom)?.step ?? null,
        },
      }),
    );
  }

  function projectPlaces(
    places: readonly PlaceLabel[],
  ): PositionedLabel[] {
    const candidates: PositionedLabel[] = [];
    for (const place of places) {
      const point = map.latLngToContainerPoint([place.lat, place.lon]);
      const width = labelWidth(place.name, 11);
      const height = labelHeight(11);
      candidates.push({
        id: `place:${place.name}`,
        text: place.name,
        rank: place.rank,
        lat: place.lat,
        lng: place.lon,
        x: point.x - width / 2,
        y: point.y - height / 2,
        width,
        height,
      });
    }
    return candidates;
  }

  function projectCountries(
    zoom: number,
    viewport: { width: number; height: number },
    occupied: readonly Box[],
  ): PositionedLabel[] {
    const candidates: Array<PositionedLabel & { area: number }> = [];
    for (const label of countryList) {
      const bounds = countryBounds.get(label.id);
      if (!bounds) continue;
      const area = boundsAreaPx(bounds);
      if (!countryLabelVisible(zoom, area)) continue;
      const point = map.latLngToContainerPoint([label.lat, label.lon]);
      if (
        point.x < 0 ||
        point.x > viewport.width ||
        point.y < 0 ||
        point.y > viewport.height
      ) {
        continue;
      }
      const width = labelWidth(label.name, 10, true);
      const height = labelHeight(10);
      const box: PositionedLabel & { area: number } = {
        id: `country:${label.id}`,
        text: label.name,
        // Countries come after every city label; larger countries first.
        rank: 100,
        lat: label.lat,
        lng: label.lon,
        x: point.x - width / 2,
        y: point.y - height / 2,
        width,
        height,
        area,
      };
      if (occupied.some((other) => boxesOverlap(box, other, 2))) continue;
      candidates.push(box);
    }
    candidates.sort((a, b) => b.area - a.area || a.text.localeCompare(b.text));
    return candidates.map((candidate, index) => ({
      ...candidate,
      rank: 100 + index,
    }));
  }

  function boundsAreaPx(bounds: LatLonBounds): number {
    const topLeft = map.latLngToContainerPoint([
      bounds.maxLat,
      bounds.minLon,
    ]);
    const bottomRight = map.latLngToContainerPoint([
      bounds.minLat,
      bounds.maxLon,
    ]);
    return Math.abs(bottomRight.x - topLeft.x) * Math.abs(bottomRight.y - topLeft.y);
  }

  function addLabelMarkers(
    labels: readonly PositionedLabel[],
    className: string,
  ): void {
    for (const label of labels) {
      L.marker([label.lat, label.lng], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className,
          html: escapeHtml(label.text),
          iconSize: [label.width, label.height],
          iconAnchor: [label.width / 2, label.height / 2],
        }),
      }).addTo(labelLayer);
    }
  }

  /**
   * Faint context rings. The rows come from the shared dataset client; a
   * missing row is skipped, never synthesized, and a stale draw is dropped
   * after clear()/destroy().
   */
  function drawAncestorRings(
    path: readonly number[],
    generation: number,
  ): void {
    if (!detailed) return;
    void (async () => {
      try {
        const { openRegionDataset } = await import("./session");
        const dataset = await openRegionDataset();
        const ancestors = ancestorPaths(path);
        for (let index = 0; index < ancestors.length; index += 1) {
          const row = await dataset.lookupRow(ancestors[index]!);
          if (row === null) continue;
          if (destroyed || generation !== drawGeneration) return;
          const rect = L.rectangle(
            [
              [row.minLat, row.minLon],
              [row.maxLat, row.maxLon],
            ],
            {
              className:
                index === 0
                  ? "region-ring region-ring--parent"
                  : "region-ring region-ring--grandparent",
              interactive: false,
              fill: false,
              weight: 1,
            },
          ).addTo(cellLayer);
          rect.bringToBack();
        }
      } catch {
        // Context only; the sidebar is the record.
      }
    })();
  }

  function drawSelectedChildren(
    row: RegionRow,
    generation: number,
  ): void {
    if (!detailed) return;
    void (async () => {
      try {
        const { openRegionDataset } = await import("./session");
        const dataset = await openRegionDataset();
        for (let digit = 0; digit < 8; digit += 1) {
          const child = await dataset.lookupRow([...row.path, digit]);
          // Provisional children have no row. Never invent a rectangle.
          if (child === null) continue;
          if (destroyed || generation !== drawGeneration) return;
          const rect = L.rectangle(
            [
              [child.minLat, child.minLon],
              [child.maxLat, child.maxLon],
            ],
            {
              className: "region-ring region-ring--child",
              interactive: false,
              fill: false,
              weight: 1,
            },
          ).addTo(cellLayer);
          rect.bringToBack();
        }
      } catch {
        // Context only.
      }
    })();
  }

  const stage: MapStage = {
    detail,
    map,
    invalidate() {
      window.requestAnimationFrame(() => {
        map.invalidateSize();
        if (!detailed) return;
        renderGraticule();
        if (labelsReady) renderLabels();
      });
    },
    destroy() {
      destroyed = true;
      drawGeneration += 1;
      if (graticuleTimer !== null) window.clearTimeout(graticuleTimer);
      if (labelTimer !== null) window.clearTimeout(labelTimer);
      graticuleTimer = null;
      labelTimer = null;
      map.remove();
    },
    clear() {
      drawGeneration += 1;
      cellLayer.clearLayers();
    },
    addCell(row, className) {
      L.rectangle(
        [
          [row.minLat, row.minLon],
          [row.maxLat, row.maxLon],
        ],
        { className, interactive: false },
      ).addTo(cellLayer);
      if (className.includes("region-cell--own")) {
        drawAncestorRings(row.path, drawGeneration);
      }
    },
    addLabel(row, text, className, size = [24, 18]) {
      L.marker(
        L.latLng((row.minLat + row.maxLat) / 2, (row.minLon + row.maxLon) / 2),
        {
          interactive: false,
          keyboard: false,
          title: text,
          icon: L.divIcon({
            className,
            html: text,
            iconSize: size,
          }),
        },
      ).addTo(cellLayer);
    },
    addPoint(point, className = "region-point", radius = 6) {
      L.circleMarker([point.lat, point.lng], {
        radius,
        className,
        interactive: false,
      }).addTo(cellLayer);
    },
    drawSelection(row) {
      L.rectangle(
        [
          [row.minLat, row.minLon],
          [row.maxLat, row.maxLon],
        ],
        { className: "region-cell region-cell--selected", interactive: false },
      ).addTo(cellLayer);
      drawSelectedChildren(row, drawGeneration);
    },
    fitRows(rows, fit = {}) {
      const points = corners(rows, fit.point ?? null);
      if (points.length === 0) {
        map.setView(WORLD_VIEW, WORLD_ZOOM);
        return;
      }
      map.fitBounds(L.latLngBounds(points), {
        padding: fit.padding ?? [16, 16],
        maxZoom: fit.maxZoom ?? 8,
        animate,
      });
    },
    setWorld() {
      map.setView(WORLD_VIEW, WORLD_ZOOM, { animate });
    },
    setView(point, zoom) {
      map.setView([point.lat, point.lng], zoom, { animate });
    },
    zoomIn() {
      map.zoomIn(1, { animate });
    },
    zoomOut() {
      map.zoomOut(1, { animate });
    },
  };

  return stage;
}

function corners(
  rows: readonly RegionRow[],
  point?: MapPoint | null,
): L.LatLngTuple[] {
  const points: L.LatLngTuple[] = [];
  for (const row of rows) {
    points.push([row.minLat, row.minLon], [row.maxLat, row.maxLon]);
  }
  if (point) points.push([point.lat, point.lng]);
  return points;
}

function boundsOfGeometry(value: unknown): LatLonBounds | null {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  const coordinates = (value as { coordinates?: unknown } | null)?.coordinates;
  walk(coordinates ?? value);
  if (!Number.isFinite(minLat)) return null;
  return { minLat, maxLat, minLon, maxLon };

  function walk(node: unknown): void {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      const lng = node[0];
      const lat = node[1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLon) minLon = lng;
      if (lng > maxLon) maxLon = lng;
      return;
    }
    for (const child of node) walk(child);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
