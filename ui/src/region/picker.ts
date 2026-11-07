/**
 * Region picker dialog: a Leaflet map with no tile layer, the vendored country
 * geometry, and point/cell resolution from the region dataset.
 *
 * Loaded lazily from `#region-open`, so Leaflet and the geometry stay out of
 * the initial bundle. Offline builds use the in-memory fixture; the live build
 * reads the published manifest once the constants are set.
 *
 * Two modes share the one map:
 * - place: the original point → deepest published cell lookup;
 * - zone: a zone's own octal address → its cell and eight child regions.
 * The designation/review flows build on `openZoneRegion` in a later pass.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries from "../assets/countries-110m.json";
import { errorMessage } from "../util";
import { REGIONS_MANIFEST_CODE_HASH, REGIONS_MANIFEST_INSTANCE } from "./constants";
import {
  ManifestInvalid,
  ManifestUnavailable,
  NoPublishedCell,
  RegionDataset,
  ShardInvalid,
  ShardMissing,
  type ResolvedCell,
} from "./dataset";
import {
  assignmentWarning,
  rankAssignmentChoices,
  type AssignmentPoint,
  type SlotRecommendation,
} from "./assignment";
import { buildFixture } from "./fixture";
import { normalizePoint } from "./geo";
import { pathToAddress } from "./paths";
import {
  BlobReader,
  ContractSource,
  FixtureSource,
  contractKeyFromInstance,
  type RegionSource,
} from "./source";
import type { RegionRow } from "./wire";
import {
  resolveZoneRegion,
  type ChildRegion,
  type SlotOccupancy,
  type ZoneRegion,
} from "./zone-region";

export interface ZoneRegionOptions {
  /** Octal address, "" for a root. */
  address: string;
  /** Exactly eight slot occupancies, in slot order. */
  slots: ReadonlyArray<SlotOccupancy>;
  /** Shows the assign footer action when present. */
  onAssign?: () => void;
  /** Called once the zone's region resolves. */
  onResolved?: (region: ZoneRegion) => void;
}

export interface AssignRegionOptions {
  /** Parent zone, "" for root. */
  address: string;
  /** Exactly eight parent slot occupancies, in slot order. */
  slots: ReadonlyArray<SlotOccupancy>;
  initialPoint?: AssignmentPoint | null;
  /** The caller opens the existing slot editor for the chosen slot. */
  onChoose(slot: number): void;
}

export interface ReviewRegionOptions {
  /** The prospective child address (parent address + digit). */
  address: string;
  /** The parent's octal address. */
  parentAddress: string;
  /** The parent's slots, for context. */
  slots: ReadonlyArray<SlotOccupancy>;
  /** The candidate's own location, if known. */
  point?: AssignmentPoint | null;
}

const numberFormat = new Intl.NumberFormat();
const WORLD_VIEW: L.LatLngExpression = [20, 0];
const WORLD_ZOOM = 1;
const NO_POINT_HINT = "Add their location to see the best-fit cell.";

type TabMode = "place" | "zone";
type Mode = TabMode | "assign" | "review";

let map: L.Map | null = null;
let layer: L.LayerGroup | null = null;
let datasetPromise: Promise<RegionDataset> | null = null;
let bound = false;
let generation = 0;
let zoneGeneration = 0;
let assignGeneration = 0;
let reviewGeneration = 0;
let mode: Mode = "place";
let zoneOptions: ZoneRegionOptions | null = null;
let lastResolved: ResolvedCell | null = null;
let returnFocus: HTMLElement | null = null;

interface AssignState {
  options: AssignRegionOptions;
  region: ZoneRegion | null;
  choices: SlotRecommendation[];
  point: AssignmentPoint | null;
  selectedSlot: number | null;
}

let assignState: AssignState | null = null;
let reviewOptions: ReviewRegionOptions | null = null;

/**
 * The original picker entry point. Kept as the place mode so the existing
 * first-run/e2e behaviour is unchanged.
 */
export function openRegionPicker(): void {
  const dialog = dialogElement();
  if (!bound) {
    bind(dialog);
    bound = true;
  }

  const leavingZone =
    mode === "zone" || mode === "assign" || mode === "review";
  mode = "place";
  zoneGeneration += 1;
  assignGeneration += 1;
  reviewGeneration += 1;
  showTabs(false);
  showPanel("place");
  setPlaceChrome();
  if (leavingZone) {
    clearLayers();
    if (lastResolved) {
      draw(lastResolved);
      render(lastResolved);
    }
    setStatus("");
  }
  openDialog(dialog);
}

/**
 * The zone display mode. Presentational only: the caller supplies the address
 * and slot occupancy; this module resolves the geometry through the dataset.
 */
export function openZoneRegion(options: ZoneRegionOptions): void {
  const dialog = dialogElement();
  if (!bound) {
    bind(dialog);
    bound = true;
  }

  generation += 1;
  zoneGeneration += 1;
  assignGeneration += 1;
  reviewGeneration += 1;
  zoneOptions = options;
  mode = "zone";
  showTabs(true);
  showPanel("zone");
  setZoneChrome(false);
  openDialog(dialog);
  void loadZone();
}

/**
 * Assignment mode: the parent chooses a free child cell. The map, cards and
 * warning all read one resolved zone region and one optional point.
 */
export function openAssignRegion(options: AssignRegionOptions): void {
  const dialog = dialogElement();
  if (!bound) {
    bind(dialog);
    bound = true;
  }

  generation += 1;
  zoneGeneration += 1;
  assignGeneration += 1;
  reviewGeneration += 1;
  assignState = {
    options,
    region: null,
    choices: [],
    point: options.initialPoint ? { ...options.initialPoint } : null,
    selectedSlot: null,
  };
  mode = "assign";
  showTabs(false);
  showPanel("assign");
  setAssignChrome();
  resetAssignUi();
  fillAssignPointFields(assignState.point);
  openDialog(dialog);
  void loadAssign();
}

/**
 * Review mode: informational only. The existing parent-save flow owns the
 * signature; this screen just shows the prospective region before it.
 */
export function openRegionReview(options: ReviewRegionOptions): void {
  const dialog = dialogElement();
  if (!bound) {
    bind(dialog);
    bound = true;
  }

  generation += 1;
  zoneGeneration += 1;
  assignGeneration += 1;
  reviewGeneration += 1;
  reviewOptions = options;
  mode = "review";
  showTabs(false);
  showPanel("review");
  setReviewChrome();
  resetReviewUi();
  openDialog(dialog);
  void loadReview();
}

function dialogElement(): HTMLDialogElement {
  return byId<HTMLDialogElement>("region-dialog");
}

function openDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !dialog.contains(active)
    ) {
      returnFocus = active;
    }
    dialog.showModal();
  }
  // The map was created while hidden; Leaflet needs a size once visible.
  window.requestAnimationFrame(() => map?.invalidateSize());
  byId<HTMLHeadingElement>("region-dialog-title").focus();
}

function bind(dialog: HTMLDialogElement): void {
  const element = byId<HTMLElement>("region-map");
  map = L.map(element, {
    crs: L.CRS.EPSG4326,
    center: WORLD_VIEW,
    zoom: WORLD_ZOOM,
    minZoom: 1,
    maxZoom: 8,
    worldCopyJump: true,
    attributionControl: false,
    // The map is decorative: the coordinate form and the cell list are the
    // keyboard path, so keep every map control out of the tab order.
    keyboard: false,
    zoomControl: false,
  });
  element.removeAttribute("tabindex");

  const topology = countries as unknown as Topology<{
    countries: GeometryCollection;
  }>;
  const geometry = feature(topology, topology.objects.countries);
  L.geoJSON(geometry as unknown as GeoJSON.GeoJsonObject, {
    style: () => ({
      color: "#b7b1a3",
      weight: 0.5,
      fillColor: "#f4f1ea",
      fillOpacity: 1,
    }),
  }).addTo(map);

  layer = L.layerGroup().addTo(map);
  map.on("click", (event: L.LeafletMouseEvent) => {
    if (mode === "place") {
      void showPoint(event.latlng.lat, event.latlng.lng);
    } else if (mode === "assign") {
      setAssignPoint(
        { lat: event.latlng.lat, lng: event.latlng.lng },
        false,
      );
    }
  });

  byId<HTMLButtonElement>("region-close").addEventListener("click", () => {
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    zoneGeneration += 1;
    assignGeneration += 1;
    reviewGeneration += 1;
    const target = returnFocus;
    returnFocus = null;
    (target ?? byId<HTMLButtonElement>("region-open")).focus();
  });
  byId<HTMLFormElement>("region-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (mode !== "place") return;
    const lat = Number(byId<HTMLInputElement>("region-lat").value);
    const lng = Number(byId<HTMLInputElement>("region-lng").value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setStatus("Enter a latitude and longitude.");
      return;
    }
    void showPoint(lat, lng);
  });

  byId<HTMLButtonElement>("region-tab-zone").addEventListener("click", () => {
    switchTab("zone", false);
  });
  byId<HTMLButtonElement>("region-tab-place").addEventListener("click", () => {
    switchTab("place", false);
  });
  byId<HTMLElement>("region-tabs").addEventListener("keydown", (event) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const next: TabMode =
      event.key === "ArrowLeft" || event.key === "Home" ? "zone" : "place";
    switchTab(next, true);
  });

  byId<HTMLButtonElement>("region-assign").addEventListener("click", () => {
    if (zoneOptions?.onAssign) zoneOptions.onAssign();
  });
  byId<HTMLFormElement>("region-assign-point-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      applyAssignPointFields();
    },
  );
  byId<HTMLButtonElement>("region-assign-cancel").addEventListener(
    "click",
    () => dialog.close(),
  );
  byId<HTMLButtonElement>("region-assign-choose").addEventListener(
    "click",
    chooseAssignSlot,
  );
  byId<HTMLButtonElement>("region-review-close").addEventListener(
    "click",
    () => dialog.close(),
  );

  byId<HTMLElement>("region-source").textContent = isOffline()
    ? "Sample region data (not the live dataset)."
    : "Geometry: Natural Earth (public domain).";
}

function switchTab(next: TabMode, focus: boolean): void {
  if (next === mode) {
    if (focus) {
      byId<HTMLButtonElement>(
        next === "zone" ? "region-tab-zone" : "region-tab-place",
      ).focus();
    }
    return;
  }

  if (next === "place") {
    mode = "place";
    zoneGeneration += 1;
    assignGeneration += 1;
    reviewGeneration += 1;
    showPanel("place");
    setPlaceChrome();
    clearLayers();
    if (lastResolved) {
      draw(lastResolved);
      render(lastResolved);
    }
    setStatus("");
  } else {
    generation += 1;
    assignGeneration += 1;
    reviewGeneration += 1;
    mode = "zone";
    showPanel("zone");
    setZoneChrome(false);
    void loadZone();
  }

  if (focus) {
    byId<HTMLButtonElement>(
      next === "zone" ? "region-tab-zone" : "region-tab-place",
    ).focus();
  }
}

function showPanel(modeToShow: Mode): void {
  const zoneSelected = modeToShow === "zone";
  const placeSelected = modeToShow === "place";
  const tabZone = byId<HTMLButtonElement>("region-tab-zone");
  const tabPlace = byId<HTMLButtonElement>("region-tab-place");
  tabZone.setAttribute("aria-selected", String(zoneSelected));
  tabZone.tabIndex = zoneSelected ? 0 : -1;
  tabPlace.setAttribute("aria-selected", String(placeSelected));
  tabPlace.tabIndex = placeSelected ? 0 : -1;
  byId<HTMLElement>("region-panel-zone").hidden = !zoneSelected;
  byId<HTMLElement>("region-panel-place").hidden = !placeSelected;
  byId<HTMLElement>("region-assign-panel").hidden = modeToShow !== "assign";
  byId<HTMLElement>("region-review-panel").hidden = modeToShow !== "review";
}

function showTabs(visible: boolean): void {
  byId<HTMLElement>("region-tabs").hidden = !visible;
}

function setZoneChrome(root: boolean): void {
  byId<HTMLHeadingElement>("region-dialog-title").textContent =
    "Your zone's region";
  byId<HTMLElement>("region-dialog-desc").textContent = root
    ? "A root zone is the whole world. It has no cell of its own; its eight slots are the world's first eight regions."
    : "Your zone's region is its octal address. The map shows its cell and its eight child regions.";
}

function setPlaceChrome(): void {
  byId<HTMLHeadingElement>("region-dialog-title").textContent =
    "Find your region";
  byId<HTMLElement>("region-dialog-desc").textContent =
    "Pick a point on the map, or type coordinates. This is the region dataset, not the zone tree.";
}

function setAssignChrome(): void {
  byId<HTMLHeadingElement>("region-dialog-title").textContent =
    "Assign a child region";
  byId<HTMLElement>("region-dialog-desc").textContent =
    "Choose where the new zone sits inside this zone. Its slot becomes the next address digit.";
}

function setReviewChrome(): void {
  byId<HTMLHeadingElement>("region-dialog-title").textContent =
    "Your assigned region";
  byId<HTMLElement>("region-dialog-desc").textContent =
    "This is the region the parent assigned. It becomes your address when both zones point at each other.";
}

async function loadZone(): Promise<void> {
  const request = ++zoneGeneration;
  const options = zoneOptions;
  const panel = byId<HTMLElement>("region-panel-zone");
  panel.setAttribute("aria-busy", "true");

  const address = options ? formatAddress(options.address) : "—";
  byId<HTMLElement>("region-legend-own").hidden = false;
  byId<HTMLElement>("region-cells-title").textContent = "Your child regions";
  byId<HTMLElement>("region-zone-address").textContent = address;
  byId<HTMLElement>("region-zone-letters").textContent = "";
  const badge = byId<HTMLElement>("region-zone-badge");
  badge.hidden = true;
  badge.textContent = "";
  badge.removeAttribute("data-state");
  byId<HTMLElement>("region-zone-state").textContent = "Reading the map…";
  const note = byId<HTMLElement>("region-zone-note");
  note.hidden = true;
  note.textContent = "";
  byId<HTMLElement>("region-cells").replaceChildren();
  byId<HTMLElement>("region-cells-count").textContent = "";
  const empty = byId<HTMLElement>("region-cells-empty");
  empty.hidden = true;
  empty.textContent = "";
  byId<HTMLElement>("region-assign-actions").hidden = true;
  clearLayers();
  setStatus("Reading your zone's region…");

  if (!options) {
    renderZoneError("No zone address was provided.");
    panel.setAttribute("aria-busy", "false");
    return;
  }

  try {
    const dataset = await loadDataset();
    const region = await resolveZoneRegion(
      dataset,
      options.address,
      options.slots,
    );
    if (request !== zoneGeneration) return;
    renderZone(region);
    drawRegion(region);
    options.onResolved?.(region);
    panel.setAttribute("aria-busy", "false");
  } catch (error) {
    if (request !== zoneGeneration) return;
    renderZoneError(messageForZone(error));
    panel.setAttribute("aria-busy", "false");
  }
}

function resetAssignUi(): void {
  byId<HTMLElement>("region-assign-cards").replaceChildren();
  const empty = byId<HTMLElement>("region-assign-empty");
  empty.hidden = true;
  empty.textContent = "";
  byId<HTMLElement>("region-assign-summary").textContent =
    "Reading the region…";
  const warning = byId<HTMLElement>("region-assign-warning");
  warning.hidden = true;
  warning.textContent = "";
  warning.classList.remove("is-hint");
  const choose = byId<HTMLButtonElement>("region-assign-choose");
  choose.disabled = true;
  choose.textContent = "Use this cell";
  setStatus("Reading your zone's region…");
}

function fillAssignPointFields(point: AssignmentPoint | null): void {
  byId<HTMLInputElement>("region-assign-lat").value =
    point === null ? "" : String(point.lat);
  byId<HTMLInputElement>("region-assign-lng").value =
    point === null ? "" : String(point.lng);
}

function applyAssignPointFields(): void {
  const state = assignState;
  if (!state || mode !== "assign") return;
  const latText = byId<HTMLInputElement>("region-assign-lat").value.trim();
  const lngText = byId<HTMLInputElement>("region-assign-lng").value.trim();

  if (latText === "" && lngText === "") {
    state.point = null;
    state.selectedSlot = null;
    renderAssign(true);
    setStatus("");
    return;
  }
  const lat = Number(latText);
  const lng = Number(lngText);
  if (
    latText === "" ||
    lngText === "" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    setStatus("Enter a latitude and longitude.");
    return;
  }
  setAssignPoint({ lat, lng });
}

function setAssignPoint(
  point: AssignmentPoint,
  focusSelected = true,
): void {
  const state = assignState;
  if (!state || mode !== "assign") return;
  state.point = normalizePoint(point.lat, point.lng);
  state.selectedSlot = null;
  fillAssignPointFields(state.point);
  renderAssign(focusSelected);
  setStatus("");
}

async function loadAssign(): Promise<void> {
  const request = ++assignGeneration;
  const state = assignState;
  if (!state) return;

  try {
    const dataset = await loadDataset();
    const region = await resolveZoneRegion(
      dataset,
      state.options.address,
      state.options.slots,
    );
    if (request !== assignGeneration || mode !== "assign" || assignState !== state) {
      return;
    }
    state.region = region;
    renderAssign(false);
    setStatus("");
  } catch (error) {
    if (request !== assignGeneration || mode !== "assign") return;
    renderAssignError(messageForZone(error));
  }
}

function renderAssign(focusSelected: boolean): void {
  const state = assignState;
  if (!state || state.region === null) return;

  state.choices = rankAssignmentChoices(state.region, state.point);
  const current = state.choices.find(
    (choice) => choice.child.slot === state.selectedSlot && choice.free,
  );
  if (!current) state.selectedSlot = null;
  if (state.selectedSlot === null && state.point !== null) {
    const firstFree = state.choices.find((choice) => choice.free);
    if (firstFree) state.selectedSlot = firstFree.child.slot;
  }

  renderAssignCards(state.choices);
  updateAssignSelection();
  drawAssign();
  if (focusSelected) focusSelectedAssignCard();
}

function renderAssignCards(choices: readonly SlotRecommendation[]): void {
  const state = assignState;
  if (!state) return;
  const container = byId<HTMLElement>("region-assign-cards");
  const cards: HTMLElement[] = [];

  for (const choice of choices) {
    const child = choice.child;
    const label = document.createElement("label");
    label.className = "region-assign-card";
    label.dataset.slot = String(child.slot);
    label.dataset.state = choice.free
      ? child.provisional
        ? "provisional"
        : "published"
      : "taken";
    label.dataset.selected = String(child.slot === state.selectedSlot);
    if (choice.bestFit) label.dataset.bestFit = "true";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "region-assign-slot";
    input.value = String(child.slot);
    input.checked = child.slot === state.selectedSlot;
    input.disabled = !choice.free;
    input.addEventListener("change", () => {
      if (!input.checked || !choice.free) return;
      state.selectedSlot = child.slot;
      updateAssignSelection();
      drawAssign();
    });

    const body = document.createElement("span");
    body.className = "region-assign-card-body";

    const head = document.createElement("span");
    head.className = "region-assign-card-head";
    const slot = document.createElement("strong");
    slot.className = "region-assign-card-slot";
    slot.textContent = `Slot ${child.slot + 1}`;
    const letter = document.createElement("span");
    letter.className = "region-assign-card-letter";
    letter.textContent = `cell ${child.letter}`;
    const address = document.createElement("code");
    address.className = "region-assign-card-address";
    address.textContent = child.address;
    head.append(slot, letter, address);
    if (choice.bestFit) {
      const badge = document.createElement("span");
      badge.className = "region-assign-best";
      badge.textContent = "Best fit";
      head.append(badge);
    }

    const meta = document.createElement("span");
    meta.className = "region-assign-card-meta";
    const parts = [child.provisional ? "Provisional" : "Published"];
    if (!choice.free) parts.unshift("Taken");
    if (child.row) {
      parts.push(`population ${numberFormat.format(child.row.population)}`);
    }
    meta.textContent = parts.join(" · ");

    body.append(head, meta);
    label.append(input, body);
    cards.push(label);
  }

  container.replaceChildren(...cards);

  const free = choices.filter((choice) => choice.free).length;
  const empty = byId<HTMLElement>("region-assign-empty");
  if (free === 0) {
    empty.textContent = "Every slot is taken. This zone cannot accept a new child.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
    empty.textContent = "";
  }
}

function updateAssignSelection(): void {
  const state = assignState;
  if (!state || state.region === null) return;

  const choice =
    state.choices.find(
      (candidate) => candidate.child.slot === state.selectedSlot,
    ) ?? null;

  for (const card of byId<HTMLElement>("region-assign-cards").querySelectorAll<HTMLElement>(
    ".region-assign-card",
  )) {
    card.dataset.selected = String(
      Number(card.dataset.slot) === state.selectedSlot,
    );
  }

  const summary = byId<HTMLElement>("region-assign-summary");
  if (choice) {
    const stateText = choice.free
      ? choice.child.provisional
        ? "provisional"
        : "published"
      : "taken";
    summary.textContent =
      `Slot ${choice.child.slot + 1} selected: cell ${choice.child.letter}, ` +
      `address ${choice.child.address}, ${stateText}.` +
      (choice.bestFit ? " Best fit." : "");
  } else {
    summary.textContent = "No cell selected.";
  }

  const warning = byId<HTMLElement>("region-assign-warning");
  if (state.point === null) {
    warning.textContent = NO_POINT_HINT;
    warning.hidden = false;
    warning.classList.add("is-hint");
  } else {
    const text = assignmentWarning(choice, state.region, state.point);
    warning.textContent = text ?? "";
    warning.hidden = text === null;
    warning.classList.remove("is-hint");
  }

  byId<HTMLButtonElement>("region-assign-choose").disabled = !choice?.free;
}

function focusSelectedAssignCard(): void {
  const state = assignState;
  if (!state) return;
  const card = byId<HTMLElement>("region-assign-cards").querySelector<HTMLElement>(
    `.region-assign-card[data-slot="${state.selectedSlot}"]`,
  );
  card?.querySelector<HTMLInputElement>("input")?.focus();
}

function chooseAssignSlot(): void {
  const state = assignState;
  if (!state) return;
  const choice = state.choices.find(
    (candidate) => candidate.child.slot === state.selectedSlot && candidate.free,
  );
  if (!choice) return;
  const slot = choice.child.slot;
  // Close first so the caller can open the slot editor without nesting modals.
  dialogElement().close();
  state.options.onChoose(slot);
}

function renderAssignError(message: string): void {
  byId<HTMLElement>("region-assign-cards").replaceChildren();
  const empty = byId<HTMLElement>("region-assign-empty");
  empty.textContent = "The child regions could not be loaded.";
  empty.hidden = false;
  byId<HTMLElement>("region-assign-summary").textContent = "";
  const warning = byId<HTMLElement>("region-assign-warning");
  warning.hidden = true;
  warning.textContent = "";
  warning.classList.remove("is-hint");
  byId<HTMLButtonElement>("region-assign-choose").disabled = true;
  clearLayers();
  setStatus(message);
}

function drawAssign(): void {
  const state = assignState;
  if (!state || state.region === null) return;
  drawRegion(state.region, {
    selectedSlot: state.selectedSlot,
    point: state.point,
    fitPoint: true,
  });
}

function resetReviewUi(): void {
  byId<HTMLElement>("region-review-address").textContent = "—";
  const badge = byId<HTMLElement>("region-review-badge");
  badge.hidden = true;
  badge.textContent = "";
  badge.removeAttribute("data-state");
  byId<HTMLElement>("region-review-parent").textContent = "";
  byId<HTMLElement>("region-review-cell").textContent = "";
  const warning = byId<HTMLElement>("region-review-warning");
  warning.hidden = true;
  warning.textContent = "";
  setStatus("Reading your assigned region…");
}

async function loadReview(): Promise<void> {
  const request = ++reviewGeneration;
  const options = reviewOptions;
  if (!options) return;

  try {
    const dataset = await loadDataset();
    const region = await resolveZoneRegion(
      dataset,
      options.parentAddress,
      options.slots,
    );
    const child = region.children.find(
      (candidate) => candidate.address === options.address,
    );
    if (request !== reviewGeneration || mode !== "review") return;
    if (!child) {
      renderReviewError(
        "That region is not one of the parent's child cells.",
      );
      return;
    }

    const point = options.point
      ? normalizePoint(options.point.lat, options.point.lng)
      : null;
    const found =
      rankAssignmentChoices(region, point).find(
        (candidate) => candidate.child.slot === child.slot,
      ) ?? null;
    // The parent writes the slot before this review. That write *is* the
    // assignment, so it must not be reported as "already taken" here; the
    // remaining warning (provisional or location mismatch) still applies.
    const choice = found === null ? null : { ...found, free: true };

    byId<HTMLElement>("region-review-address").textContent = child.address;
    const badge = byId<HTMLElement>("region-review-badge");
    badge.hidden = false;
    badge.textContent = child.provisional ? "Provisional" : "Published";
    badge.dataset.state = child.provisional ? "provisional" : "published";
    byId<HTMLElement>("region-review-parent").textContent = region.root
      ? "Parent: the world (root)"
      : `Parent: ${region.address}`;
    byId<HTMLElement>("region-review-cell").textContent =
      `Cell ${child.letter}` +
      (child.row
        ? ` · population ${numberFormat.format(child.row.population)}`
        : " · the map does not cover this cell yet");

    const warning = byId<HTMLElement>("region-review-warning");
    const text = assignmentWarning(choice, region, point);
    warning.textContent = text ?? "";
    warning.hidden = text === null;

    drawRegion(region, {
      selectedSlot: child.slot,
      point,
      fitPoint: point !== null,
    });
    setStatus("");
  } catch (error) {
    if (request !== reviewGeneration || mode !== "review") return;
    renderReviewError(messageForZone(error));
  }
}

function renderReviewError(message: string): void {
  byId<HTMLElement>("region-review-address").textContent = "—";
  const badge = byId<HTMLElement>("region-review-badge");
  badge.hidden = true;
  badge.textContent = "";
  badge.removeAttribute("data-state");
  byId<HTMLElement>("region-review-parent").textContent = "";
  byId<HTMLElement>("region-review-cell").textContent = "Region unavailable";
  const warning = byId<HTMLElement>("region-review-warning");
  warning.hidden = true;
  warning.textContent = "";
  clearLayers();
  setStatus(message);
}

function renderZone(region: ZoneRegion): void {
  const options = zoneOptions;
  const address = region.root ? "root" : region.address;
  byId<HTMLElement>("region-zone-address").textContent = address;

  byId<HTMLElement>("region-zone-letters").textContent = region.root
    ? "the world"
    : region.cell
      ? `cell ${region.cell.letters}`
      : region.ancestor
        ? `inside ${region.ancestor.letters}`
        : "";

  byId<HTMLElement>("region-legend-own").hidden = region.root;
  const badge = byId<HTMLElement>("region-zone-badge");
  badge.hidden = false;
  if (region.root) {
    badge.textContent = "The world";
    badge.dataset.state = "root";
  } else if (region.provisional) {
    badge.textContent = "Provisional";
    badge.dataset.state = "provisional";
  } else {
    badge.textContent = "Published";
    badge.dataset.state = "published";
  }

  byId<HTMLElement>("region-zone-state").textContent = stateLine(region);

  const note = byId<HTMLElement>("region-zone-note");
  const noteText = noteFor(region);
  note.textContent = noteText;
  note.hidden = noteText === "";

  byId<HTMLElement>("region-cells-count").textContent =
    `${region.freeCount} free of 8`;
  byId<HTMLElement>("region-cells-title").textContent =
    region.root ? "The world's eight regions" : "Your child regions";

  const list = byId<HTMLElement>("region-cells");
  list.replaceChildren(...region.children.map(renderCellRow));

  const empty = byId<HTMLElement>("region-cells-empty");
  empty.hidden = true;
  empty.textContent = "";

  if (options?.onAssign) {
    byId<HTMLElement>("region-assign-actions").hidden = false;
    const assign = byId<HTMLButtonElement>("region-assign");
    assign.disabled = region.freeCount === 0;
    assign.textContent =
      region.freeCount === 0
        ? "Every slot is taken"
        : "Assign a child region…";
  } else {
    byId<HTMLElement>("region-assign-actions").hidden = true;
  }

  setZoneChrome(region.root);
  setStatus(
    `${region.root ? "The world" : `Region ${region.address}`} loaded. ${region.freeCount} free of 8.`,
  );
}

function stateLine(region: ZoneRegion): string {
  if (region.root) {
    return "A root zone is the whole world. It has no cell of its own.";
  }
  if (region.provisional) {
    const ancestor = region.ancestor;
    return ancestor
      ? `Provisional — shown inside ${ancestor.letters} (${pathToAddress(ancestor.path)}). The map does not cover this area yet.`
      : "Provisional — the map does not cover this area yet.";
  }
  if (region.cell) {
    return `Depth ${region.cell.path.length} · population ${numberFormat.format(region.cell.population)}`;
  }
  return "";
}

function noteFor(region: ZoneRegion): string {
  if (region.root) {
    return "Your eight slots are the world's first eight regions.";
  }
  if (region.provisional) {
    return "Provisional cells are not guessed shapes. They are shown inside the nearest mapped cell with their own address.";
  }
  if (region.children.some((child) => child.provisional)) {
    return "Some child cells are provisional. They are shown inside the nearest mapped cell, never as guessed shapes.";
  }
  return "";
}

function renderCellRow(child: ChildRegion): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "region-cell-row";
  row.dataset.state = child.occupied;
  row.dataset.provisional = String(child.provisional);

  const digit = document.createElement("span");
  digit.className = "region-cell-digit";
  digit.textContent = child.letter;
  digit.setAttribute("aria-hidden", "true");

  const body = document.createElement("span");
  body.className = "region-cell-body";

  const line = document.createElement("span");
  line.className = "region-cell-line";
  const slot = document.createElement("span");
  slot.className = "region-cell-slot";
  slot.textContent = `Slot ${child.slot + 1}`;
  const letter = document.createElement("span");
  letter.className = "region-cell-letter";
  letter.textContent = `cell ${child.letter}`;
  const address = document.createElement("code");
  address.className = "region-cell-address";
  address.textContent = child.address;
  line.append(slot, letter, address);

  const meta = document.createElement("span");
  meta.className = "region-cell-meta";
  const details: string[] = [];
  if (child.provisional) {
    details.push(
      child.ancestor
        ? `Provisional · inside ${pathToAddress(child.ancestor.path)}`
        : "Provisional",
    );
  }
  if (child.row) {
    details.push(
      `population ${numberFormat.format(child.row.population)}`,
    );
  }
  meta.textContent = details.join(" · ");
  meta.hidden = details.length === 0;

  body.append(line, meta);

  const state = document.createElement("span");
  state.className = `region-cell-state region-cell-state--${child.occupied}`;
  state.textContent = occupancyLabel(child.occupied);

  row.append(digit, body, state);
  return row;
}

function occupancyLabel(occupancy: ChildRegion["occupied"]): string {
  if (occupancy === "free") return "Free";
  if (occupancy === "unconfirmed") return "Pending";
  return "Taken";
}

function renderZoneError(message: string): void {
  byId<HTMLElement>("region-legend-own").hidden = false;
  byId<HTMLElement>("region-cells-title").textContent = "Your child regions";
  const badge = byId<HTMLElement>("region-zone-badge");
  badge.hidden = true;
  badge.textContent = "";
  badge.removeAttribute("data-state");
  byId<HTMLElement>("region-zone-letters").textContent = "";
  byId<HTMLElement>("region-zone-state").textContent = "Map unavailable";
  const note = byId<HTMLElement>("region-zone-note");
  note.hidden = true;
  note.textContent = "";
  byId<HTMLElement>("region-cells").replaceChildren();
  byId<HTMLElement>("region-cells-count").textContent = "";
  const empty = byId<HTMLElement>("region-cells-empty");
  empty.textContent = "The child regions could not be loaded.";
  empty.hidden = false;
  byId<HTMLElement>("region-assign-actions").hidden = true;
  clearLayers();
  setStatus(message);
}

function messageForZone(error: unknown): string {
  if (error instanceof ManifestUnavailable) {
    return "The region map is unavailable right now. Your zone's address is still shown.";
  }
  if (error instanceof ManifestInvalid || error instanceof ShardInvalid) {
    return "Region data failed verification. Your zone's address is still shown.";
  }
  if (error instanceof ShardMissing) {
    return "Region detail is unavailable right now. Your zone's address is still shown.";
  }
  return `Could not read your zone's region: ${errorMessage(error)}`;
}

function formatAddress(address: string): string {
  return address === "" ? "root" : address;
}

function clearLayers(): void {
  layer?.clearLayers();
}

interface DrawRegionOptions {
  selectedSlot?: number | null;
  point?: AssignmentPoint | null;
  fitPoint?: boolean;
}

function drawRegion(
  region: ZoneRegion,
  options: DrawRegionOptions = {},
): void {
  if (!map || !layer) return;
  layer.clearLayers();

  const focusRows: RegionRow[] = [];
  const ownRow = region.cell ?? region.ancestor;
  if (!region.root && ownRow) {
    const classes = `region-cell region-cell--own${
      region.provisional ? " region-cell--provisional" : ""
    }`;
    addCell(ownRow, classes);
    focusRows.push(ownRow);
  }

  const selectedChild =
    options.selectedSlot === null || options.selectedSlot === undefined
      ? null
      : region.children.find(
          (child) => child.slot === options.selectedSlot,
        ) ?? null;

  const publishedChildren = region.children.filter(
    (child): child is ChildRegion & { row: RegionRow } =>
      child.row !== null && !child.provisional,
  );
  for (const child of publishedChildren) {
    const selected = child.slot === options.selectedSlot;
    addCell(
      child.row,
      selected
        ? "region-cell region-cell--selected"
        : childClass(child),
    );
    addDigit(child);
    focusRows.push(child.row);
  }

  const provisionalChildren = region.children.filter(
    (child) => child.provisional,
  );
  const provisionalBase = region.ancestor ?? region.cell;
  if (provisionalChildren.length > 0 && provisionalBase) {
    if (!(region.provisional && !region.root)) {
      addCell(provisionalBase, "region-cell region-cell--provisional");
    }
    const provisionalSelection =
      selectedChild?.provisional ? selectedChild : null;
    addNote(
      provisionalBase,
      provisionalSelection
        ? `Slot ${provisionalSelection.slot + 1} · ${provisionalSelection.address}`
        : region.provisional
          ? "Provisional"
          : `+${provisionalChildren.length} provisional`,
    );
  }

  if (options.point) addPoint(options.point);

  if (focusRows.length > 0 || (options.fitPoint && options.point)) {
    fitRows(
      focusRows,
      options.fitPoint ? options.point ?? null : null,
    );
  } else {
    map.setView(WORLD_VIEW, WORLD_ZOOM);
  }
}

function addPoint(point: AssignmentPoint): void {
  if (!layer) return;
  L.circleMarker([point.lat, point.lng], {
    radius: 6,
    className: "region-point",
    interactive: false,
  }).addTo(layer);
}

function addCell(row: RegionRow, className: string): void {
  if (!layer) return;
  L.rectangle(
    [
      [row.minLat, row.minLon],
      [row.maxLat, row.maxLon],
    ],
    { className, interactive: false },
  ).addTo(layer);
}

function addDigit(child: ChildRegion & { row: RegionRow }): void {
  if (!layer) return;
  const row = child.row;
  const stateClass = child.occupied === "free" ? "free" : "taken";
  L.marker(
    L.latLng(
      (row.minLat + row.maxLat) / 2,
      (row.minLon + row.maxLon) / 2,
    ),
    {
      interactive: false,
      title: `Slot ${child.slot + 1} · address ${child.address}`,
      icon: L.divIcon({
        className: `region-digit region-digit--${stateClass}${
          child.provisional ? " region-digit--provisional" : ""
        }`,
        html: child.letter,
        iconSize: [24, 18],
      }),
    },
  ).addTo(layer);
}

function addNote(row: RegionRow, text: string): void {
  if (!layer) return;
  L.marker(
    L.latLng(
      (row.minLat + row.maxLat) / 2,
      (row.minLon + row.maxLon) / 2,
    ),
    {
      interactive: false,
      icon: L.divIcon({
        className: "region-note",
        html: text,
        iconSize: [110, 20],
      }),
    },
  ).addTo(layer);
}

function childClass(child: ChildRegion): string {
  const stateClass = child.occupied === "free" ? "free" : "taken";
  return `region-cell region-cell--${stateClass}${
    child.provisional ? " region-cell--provisional" : ""
  }`;
}

function fitRows(
  rows: readonly RegionRow[],
  point: AssignmentPoint | null,
): void {
  if (!map) return;
  const corners: L.LatLngTuple[] = [];
  for (const row of rows) {
    corners.push([row.minLat, row.minLon], [row.maxLat, row.maxLon]);
  }
  if (point) corners.push([point.lat, point.lng]);
  if (corners.length === 0) {
    map.setView(WORLD_VIEW, WORLD_ZOOM);
    return;
  }
  map.fitBounds(L.latLngBounds(corners), {
    padding: [16, 16],
    maxZoom: 7,
    animate: !prefersReducedMotion(),
  });
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

async function showPoint(lat: number, lng: number): Promise<void> {
  if (mode !== "place") return;
  const request = ++generation;
  setStatus("Looking up the region…");
  try {
    const dataset = await loadDataset();
    const resolved = await dataset.resolve(lat, lng);
    if (request !== generation) return;
    lastResolved = resolved;
    draw(resolved);
    render(resolved);
    setStatus("");
  } catch (error) {
    if (request !== generation) return;
    byId<HTMLElement>("region-result").hidden = true;
    setStatus(messageFor(error));
  }
}

function loadDataset(): Promise<RegionDataset> {
  if (!datasetPromise) {
    datasetPromise = Promise.resolve().then(() =>
      RegionDataset.open(createSource()),
    );
    datasetPromise.catch(() => {
      datasetPromise = null;
    });
  }
  return datasetPromise;
}

function createSource(): RegionSource {
  if (isOffline()) {
    const fixture = buildFixture();
    return new FixtureSource(fixture.manifestState, fixture.shards);
  }
  if (!REGIONS_MANIFEST_INSTANCE || !REGIONS_MANIFEST_CODE_HASH) {
    throw new ManifestUnavailable("Region data is not published yet.");
  }
  return new ContractSource(
    new BlobReader(),
    contractKeyFromInstance(
      REGIONS_MANIFEST_INSTANCE,
      REGIONS_MANIFEST_CODE_HASH,
    ),
  );
}

function draw(resolved: ResolvedCell): void {
  if (!map || !layer) return;
  const row = resolved.row;
  layer.clearLayers();

  L.rectangle(
    [
      [row.minLat, row.minLon],
      [row.maxLat, row.maxLon],
    ],
    {
      color: "#2b5a4b",
      weight: 2,
      fillColor: "#2b5a4b",
      fillOpacity: 0.12,
    },
  ).addTo(layer);

  for (const child of resolved.children) {
    if (!child.row) continue;
    L.rectangle(
      [
        [child.row.minLat, child.row.minLon],
        [child.row.maxLat, child.row.maxLon],
      ],
      {
        color: "#b7b1a3",
        weight: 1,
        dashArray: "4 3",
        fillOpacity: 0,
      },
    ).addTo(layer);
    L.marker(
      L.latLng(
        (child.row.minLat + child.row.maxLat) / 2,
        (child.row.minLon + child.row.maxLon) / 2,
      ),
      {
        interactive: false,
        icon: L.divIcon({
          className: "region-digit",
          html: child.letters,
          iconSize: [24, 18],
        }),
      },
    ).addTo(layer);
  }

  map.fitBounds(
    L.latLngBounds([
      [row.minLat, row.minLon],
      [row.maxLat, row.maxLon],
    ]),
    { padding: [16, 16], maxZoom: 8 },
  );
}

function render(resolved: ResolvedCell): void {
  const row = resolved.row;
  byId<HTMLElement>("region-path").textContent = row.letters;
  byId<HTMLElement>("region-octal").textContent = row.path.join("");
  byId<HTMLElement>("region-depth").textContent = String(row.path.length);
  byId<HTMLElement>("region-bounds").textContent =
    `${format(row.minLat)}, ${format(row.minLon)} – ` +
    `${format(row.maxLat)}, ${format(row.maxLon)}`;
  byId<HTMLElement>("region-population").textContent = numberFormat.format(
    row.population,
  );

  const body = byId<HTMLElement>("region-children");
  body.replaceChildren();
  for (const child of resolved.children) {
    const tr = document.createElement("tr");
    const digit = document.createElement("th");
    digit.scope = "row";
    digit.textContent = String(child.digit);
    const letters = document.createElement("td");
    letters.textContent = child.letters;
    const population = document.createElement("td");
    population.textContent = child.row
      ? numberFormat.format(child.row.population)
      : "not published";
    tr.append(digit, letters, population);
    body.append(tr);
  }

  byId<HTMLElement>("region-result").hidden = false;
}

function messageFor(error: unknown): string {
  if (error instanceof NoPublishedCell) {
    return "No published region covers this point.";
  }
  if (error instanceof ManifestUnavailable) {
    return error.message;
  }
  if (error instanceof ManifestInvalid || error instanceof ShardInvalid) {
    return "Region data failed verification.";
  }
  if (error instanceof ShardMissing) {
    return "Region detail is unavailable right now.";
  }
  return `Could not read the region: ${errorMessage(error)}`;
}

function setStatus(text: string): void {
  byId<HTMLElement>("region-status").textContent = text;
}

function isOffline(): boolean {
  return import.meta.env.VITE_OFFLINE_MODE === "1";
}

function format(value: number): string {
  return value.toFixed(3);
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
