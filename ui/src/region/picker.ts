/**
 * Region dialog: the transactional picker (assign a child cell, review an
 * assigned cell).
 *
 * The zone viewer and "find a place" flows now live on the map page
 * (`map-page.ts`); this dialog keeps the steps that must return a choice to a
 * caller and close. The map is the shared lazy base map; the radio cards and
 * the coordinate form are the keyboard path.
 */

import { errorMessage } from "../util";
import type { MapStage } from "./map-base";
import type { AssignmentPoint, SlotRecommendation } from "./assignment";
import {
  assignmentWarning,
  rankAssignmentChoices,
} from "./assignment";
import {
  ManifestInvalid,
  ManifestUnavailable,
  ShardInvalid,
  ShardMissing,
} from "./dataset";
import { normalizePoint } from "./geo";
import { openRegionDataset } from "./session";
import type { RegionRow } from "./wire";
import {
  resolveZoneRegion,
  type ChildRegion,
  type SlotOccupancy,
  type ZoneRegion,
} from "./zone-region";

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
const NO_POINT_HINT = "Add their location to see the best-fit cell.";

type Mode = "assign" | "review";

let stage: MapStage | null = null;
let bound = false;
let assignGeneration = 0;
let reviewGeneration = 0;
let mode: Mode = "assign";
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
/** A drawing requested before Leaflet finished loading. */
let pendingDraw: { region: ZoneRegion; options: DrawRegionOptions } | null =
  null;

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

  assignGeneration += 1;
  reviewGeneration += 1;
  reviewOptions = options;
  mode = "review";
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
  stage?.invalidate();
  byId<HTMLHeadingElement>("region-dialog-title").focus();
}

function bind(dialog: HTMLDialogElement): void {
  const element = byId<HTMLElement>("region-map");
  void import("./map-base")
    .then(({ createMapStage }) => {
      try {
        stage = createMapStage(element, {
          detail: "full",
          maxZoom: 11,
          countryClassName: "region-world",
          countryStyle: {
            color: "#b7b1a3",
            weight: 0.5,
            fillColor: "#f4f1ea",
            fillOpacity: 1,
          },
          onClick: (point) => {
            if (mode === "assign") {
              setAssignPoint({ lat: point.lat, lng: point.lng }, false);
            }
          },
        });
        element.dataset.state = "ready";
        stage.invalidate();
        if (pendingDraw !== null) {
          const pending = pendingDraw;
          pendingDraw = null;
          drawRegion(pending.region, pending.options);
        }
      } catch {
        mapUnavailable(element);
      }
    })
    .catch(() => mapUnavailable(element));

  byId<HTMLButtonElement>("region-close").addEventListener("click", () => {
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    assignGeneration += 1;
    reviewGeneration += 1;
    const target = returnFocus;
    returnFocus = null;
    (target ?? byId<HTMLButtonElement>("region-open")).focus();
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

function mapUnavailable(element: HTMLElement): void {
  stage = null;
  element.dataset.state = "unavailable";
}

function showPanel(next: Mode): void {
  byId<HTMLElement>("region-assign-panel").hidden = next !== "assign";
  byId<HTMLElement>("region-review-panel").hidden = next !== "review";
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
    const dataset = await openRegionDataset();
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
  stage?.clear();
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
    const dataset = await openRegionDataset();
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
  stage?.clear();
  setStatus(message);
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
  if (stage === null) {
    pendingDraw = { region, options };
    return;
  }
  pendingDraw = null;
  stage.clear();

  const focusRows: RegionRow[] = [];
  const ownRow = region.cell ?? region.ancestor;
  if (!region.root && ownRow) {
    const classes = `region-cell region-cell--own${
      region.provisional ? " region-cell--provisional" : ""
    }`;
    stage.addCell(ownRow, classes);
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
    if (child.slot === options.selectedSlot) {
      stage.drawSelection(child.row);
    } else {
      stage.addCell(child.row, childClass(child));
    }
    addDigit(child);
    focusRows.push(child.row);
  }

  const provisionalChildren = region.children.filter(
    (child) => child.provisional,
  );
  const provisionalBase = region.ancestor ?? region.cell;
  if (provisionalChildren.length > 0 && provisionalBase) {
    if (!(region.provisional && !region.root)) {
      stage.addCell(
        provisionalBase,
        "region-cell region-cell--provisional",
      );
    }
    const provisionalSelection =
      selectedChild?.provisional ? selectedChild : null;
    stage.addLabel(
      provisionalBase,
      provisionalSelection
        ? `Slot ${provisionalSelection.slot + 1} · ${provisionalSelection.address}`
        : region.provisional
          ? "Provisional"
          : `+${provisionalChildren.length} provisional`,
      "region-note",
      [110, 20],
    );
  }

  if (options.point) {
    stage.addPoint(options.point, "region-point");
  }

  if (focusRows.length > 0 || (options.fitPoint && options.point)) {
    stage.fitRows(focusRows, {
      point: options.fitPoint ? options.point ?? null : null,
      maxZoom: 7,
    });
  } else {
    stage.setWorld();
  }
}

function addDigit(child: ChildRegion & { row: RegionRow }): void {
  if (stage === null) return;
  const stateClass = child.occupied === "free" ? "free" : "taken";
  stage.addLabel(
    child.row,
    child.letter,
    `region-digit region-digit--${stateClass}${
      child.provisional ? " region-digit--provisional" : ""
    }`,
    [24, 18],
  );
}

function childClass(child: ChildRegion): string {
  const stateClass = child.occupied === "free" ? "free" : "taken";
  return `region-cell region-cell--${stateClass}${
    child.provisional ? " region-cell--provisional" : ""
  }`;
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

function setStatus(text: string): void {
  byId<HTMLElement>("region-status").textContent = text;
}

function isOffline(): boolean {
  return import.meta.env.VITE_OFFLINE_MODE === "1";
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
