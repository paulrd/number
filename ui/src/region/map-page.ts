/**
 * The map page (`?view=map`): a large Leaflet stage plus a sidebar that is the
 * equal, keyboard and screen-reader path.
 *
 * The map is decorative (`aria-hidden`, no keyboard handler, no controls) and
 * is loaded lazily. The sidebar always carries the address, the chain to the
 * root, all eight child cells with their state and population, and the place
 * result table, so nothing lives only on the canvas.
 *
 * Selection is shared by the sidebar rows and the canvas: both call
 * `selectChild`, which highlights the row, marks it `aria-pressed`, announces
 * "Selected slot N, cell c" through `#map-status`, and offers the one inline
 * action (`#map-assign-selected`). Selecting never navigates and never opens
 * the slot editor; the action calls `MapPageDeps.onSelectCell(slot, child)`.
 * The canvas maps a click to a slot with the pure `hit-test.ts` test, so a
 * provisional child (drawn inside its nearest ancestor) stays list-only.
 */

import type { ResolvedCell } from "./dataset";
import {
  ManifestInvalid,
  ManifestUnavailable,
  NoPublishedCell,
  ShardInvalid,
  ShardMissing,
} from "./dataset";
import { errorMessage } from "../util";
import { pathToAddress } from "./paths";
import { openRegionDataset } from "./session";
import { hitTestCell } from "./hit-test";
import type { MapPoint, MapStage } from "./map-base";
import type { RegionRow } from "./wire";
import {
  resolveZoneRegion,
  type ChildRegion,
  type SlotOccupancy,
  type ZoneRegion,
} from "./zone-region";

export type MapPageTab = "zone" | "place";

/** One row of the address chain. `ownerId`/label enrichment is a later lane. */
export interface MapChainRow {
  address: string;
  label: string;
  current: boolean;
  /** Present when the caller can resolve names or open the zone. */
  ownerId?: string | null;
}

export interface MapPageDeps {
  /** The own zone's octal address, or null while it is not settled. */
  readAddress(): Promise<string | null>;
  /** Exactly eight slot occupancies. */
  readSlots(): SlotOccupancy[];
  /** Same hook the dialog used, so Advanced keeps its region line in sync. */
  onResolved?(region: ZoneRegion): void;
  /** Opens the existing assign dialog (the page does not replace it). */
  onAssign?(): void;
  /**
   * Inline handoff: called by `#map-assign-selected` for a selected free slot.
   * The caller opens the existing slot editor; selection alone never calls it.
   */
  onSelectCell?(slot: number, child: ChildRegion): void;
  /** Tab changes, so the shell can keep `place=1` in the URL. */
  onTabChange?(tab: MapPageTab): void;
  /** Optional enriched chain (names, owner ids) for a later lane. */
  readChain?(address: string): Promise<MapChainRow[]>;
  /** Optional navigation seam for chain rows. */
  onChainOpen?(row: MapChainRow): void;
  /** Called by the page's Back control; the shell owns history. */
  onBack?(): void;
  announce?(message: string): void;
}

export interface MapPage {
  open(options?: { tab?: MapPageTab }): Promise<void>;
  /** Destroy the Leaflet instance; the DOM stays for a later open. */
  close(): void;
  /** Re-resolve the own zone after a board update. */
  refresh(): void;
  tab(): MapPageTab;
}

const numberFormat = new Intl.NumberFormat();

/** Address prefixes from the world root to this zone. Pure, for tests. */
export function deriveChain(address: string): MapChainRow[] {
  if (address === "") {
    return [{ address: "", label: "root", current: true }];
  }
  const rows: MapChainRow[] = [{ address: "", label: "root", current: false }];
  for (let length = 1; length <= address.length; length += 1) {
    const prefix = address.slice(0, length);
    rows.push({
      address: prefix,
      label: prefix,
      current: length === address.length,
    });
  }
  return rows;
}

export function cellStateText(occupancy: SlotOccupancy): string {
  if (occupancy === "free") return "Free";
  if (occupancy === "unconfirmed") return "Pending";
  return "Taken";
}

/** `Published · population 1,240` or `Provisional · inside 0021`. Pure. */
export function childMetaText(child: ChildRegion): string {
  const parts: string[] = [];
  if (child.provisional) {
    parts.push(
      child.ancestor
        ? `Provisional · inside ${pathToAddress(child.ancestor.path)}`
        : "Provisional",
    );
  } else {
    parts.push("Published");
  }
  if (child.row) {
    parts.push(`population ${numberFormat.format(child.row.population)}`);
  }
  return parts.join(" · ");
}

export function stateLine(region: ZoneRegion): string {
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

/** The one line the page announces for either a row click or a map click. */
export function selectionStatusText(child: ChildRegion): string {
  return `Selected slot ${child.slot + 1}, cell ${child.letter}.`;
}

/**
 * The inline action for a selected child, or null when the row cannot be
 * assigned. Only a free slot offers it, so a taken row never reaches the
 * editor; a provisional free child stays reachable from its list row.
 */
export function selectionAction(
  child: ChildRegion | null,
): { label: string } | null {
  if (child === null || child.occupied !== "free") return null;
  return { label: `Assign slot ${child.slot + 1}…` };
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

export function createMapPage(deps: MapPageDeps): MapPage {
  const title = byId<HTMLHeadingElement>("map-title");
  const backButton = byId<HTMLButtonElement>("map-back");
  const tabs = byId<HTMLElement>("map-tabs");
  const tabZone = byId<HTMLButtonElement>("map-tab-zone");
  const tabPlace = byId<HTMLButtonElement>("map-tab-place");
  const panelZone = byId<HTMLElement>("map-panel-zone");
  const panelPlace = byId<HTMLElement>("map-panel-place");
  const canvas = byId<HTMLElement>("map-canvas");
  const controls = byId<HTMLElement>("map-controls");
  const zoomInButton = byId<HTMLButtonElement>("map-zoom-in");
  const zoomOutButton = byId<HTMLButtonElement>("map-zoom-out");
  const zoomWorldButton = byId<HTMLButtonElement>("map-zoom-world");
  const unavailable = byId<HTMLElement>("map-unavailable");
  const sourceEl = byId<HTMLElement>("map-source");
  const status = byId<HTMLElement>("map-status");
  sourceEl.textContent =
    import.meta.env.VITE_OFFLINE_MODE === "1"
      ? "Sample region data (not the live dataset)."
      : "Geometry: Natural Earth (public domain).";

  const addressEl = byId<HTMLElement>("map-zone-address");
  const lettersEl = byId<HTMLElement>("map-zone-letters");
  const badgeEl = byId<HTMLElement>("map-zone-badge");
  const stateEl = byId<HTMLElement>("map-zone-state");
  const noteEl = byId<HTMLElement>("map-zone-note");
  const chainList = byId<HTMLOListElement>("map-chain");
  const cellsTitle = byId<HTMLElement>("map-cells-title");
  const cellsCount = byId<HTMLElement>("map-cells-count");
  const cellsList = byId<HTMLOListElement>("map-cells");
  const cellsEmpty = byId<HTMLElement>("map-cells-empty");
  const cellWarning = byId<HTMLElement>("map-cell-warning");
  const assignButton = byId<HTMLButtonElement>("map-assign");
  const assignSelectedButton = byId<HTMLButtonElement>("map-assign-selected");
  const findPlaceButton = byId<HTMLButtonElement>("map-find-place");

  const placeForm = byId<HTMLFormElement>("map-place-form");
  const latInput = byId<HTMLInputElement>("map-lat");
  const lngInput = byId<HTMLInputElement>("map-lng");
  const placeResult = byId<HTMLElement>("region-result");
  const pathEl = byId<HTMLElement>("region-path");
  const octalEl = byId<HTMLElement>("region-octal");
  const depthEl = byId<HTMLElement>("region-depth");
  const boundsEl = byId<HTMLElement>("region-bounds");
  const populationEl = byId<HTMLElement>("region-population");
  const childrenBody = byId<HTMLElement>("region-children");

  let tab: MapPageTab = "zone";
  let stage: MapStage | null = null;
  let stagePromise: Promise<boolean> | null = null;
  let zoneGeneration = 0;
  let placeGeneration = 0;
  let openGeneration = 0;
  let opened = false;
  let currentRegion: ZoneRegion | null = null;
  let selectedSlot: number | null = null;
  let lastPlace: ResolvedCell | null = null;

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function announce(text: string): void {
    deps.announce?.(text);
  }

  function setPanelBusy(busy: boolean): void {
    panelZone.setAttribute("aria-busy", String(busy));
  }

  function showTab(next: MapPageTab, focus: boolean): void {
    tab = next;
    const zoneSelected = next === "zone";
    tabZone.setAttribute("aria-selected", String(zoneSelected));
    tabZone.tabIndex = zoneSelected ? 0 : -1;
    tabPlace.setAttribute("aria-selected", String(!zoneSelected));
    tabPlace.tabIndex = zoneSelected ? -1 : 0;
    panelZone.hidden = !zoneSelected;
    panelPlace.hidden = zoneSelected;
    deps.onTabChange?.(next);
    if (focus) {
      (zoneSelected ? tabZone : tabPlace).focus();
    }
    if (stage === null) return;
    if (zoneSelected) {
      if (currentRegion) drawRegion(currentRegion, selectedSlot);
    } else if (lastPlace) {
      drawPlace(lastPlace);
    } else if (currentRegion) {
      drawRegion(currentRegion, selectedSlot);
    }
  }

  /**
   * Select the child under a canvas click. `createMapStage` also receives
   * `hitTestCell`, but the page converts the container point itself so
   * selection does not depend on the stage surfacing a click callback. A
   * click only selects; the action button owns the editor handoff.
   */
  function handleCanvasClick(event: MouseEvent): void {
    if (stage === null || tab !== "zone" || currentRegion === null) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const latlng = stage.map.containerPointToLatLng([
      event.clientX - rect.left,
      event.clientY - rect.top,
    ]);
    const slot = hitTestCell(currentRegion, {
      lat: latlng.lat,
      lng: latlng.lng,
    });
    if (slot === null) return;
    const child = currentRegion.children.find((entry) => entry.slot === slot);
    if (child !== undefined) selectChild(child);
  }

  async function ensureStage(): Promise<boolean> {
    if (stage !== null) return true;
    if (stagePromise !== null) return stagePromise;
    canvas.dataset.state = "loading";
    stagePromise = (async () => {
      try {
        // Dynamic so the page shell renders even if Leaflet fails to load.
        const { createMapStage } = await import("./map-base");
        stage = createMapStage(canvas, {
          detail: "full",
          maxZoom: 11,
          onClick: (point: MapPoint) => {
            if (tab !== "place") return;
            latInput.value = String(roundCoordinate(point.lat));
            lngInput.value = String(roundCoordinate(point.lng));
            void showPoint(point.lat, point.lng);
          },
          hitTestCell: (point: MapPoint) => {
            // The place tab owns map clicks; only the zone canvas selects.
            if (tab !== "zone" || currentRegion === null) return null;
            return hitTestCell(currentRegion, point);
          },
        });
        canvas.dataset.state = "ready";
        unavailable.hidden = true;
        controls.hidden = false;
        stage.invalidate();
        // The dataset may have resolved while Leaflet was loading; paint now.
        if (tab === "place" && lastPlace) drawPlace(lastPlace);
        else if (currentRegion) drawRegion(currentRegion, selectedSlot);
        return true;
      } catch {
        stage = null;
        canvas.dataset.state = "unavailable";
        unavailable.hidden = false;
        controls.hidden = true;
        return false;
      } finally {
        stagePromise = null;
      }
    })();
    return stagePromise;
  }

  function roundCoordinate(value: number): number {
    return Math.round(value * 1e5) / 1e5;
  }

  function clearBadge(): void {
    badgeEl.hidden = true;
    badgeEl.textContent = "";
    badgeEl.removeAttribute("data-state");
  }

  function renderChain(address: string, rows: readonly MapChainRow[]): void {
    const items = rows.map((row) => {
      const item = document.createElement("li");
      item.className = "map-chain-row";
      item.dataset.current = String(row.current);
      const text = document.createElement("code");
      text.className = "map-chain-address";
      text.textContent = row.label;
      item.append(text);
      if (deps.onChainOpen) {
        const button = document.createElement("button");
        button.className = "link-button map-chain-open";
        button.type = "button";
        button.textContent = "Open";
        button.setAttribute("aria-label", `Open zone ${row.label}`);
        button.addEventListener("click", () => deps.onChainOpen?.(row));
        item.append(button);
      }
      return item;
    });
    chainList.replaceChildren(...items);
    chainList.dataset.address = address;
  }

  function renderZone(region: ZoneRegion, address: string): void {
    const display = region.root ? "root" : address;
    addressEl.textContent = display;
    lettersEl.textContent = region.root
      ? "the world"
      : region.cell
        ? `cell ${region.cell.letters}`
        : region.ancestor
          ? `inside ${region.ancestor.letters}`
          : "";

    if (region.root) {
      badgeEl.hidden = false;
      badgeEl.textContent = "The world";
      badgeEl.dataset.state = "root";
    } else if (region.provisional) {
      badgeEl.hidden = false;
      badgeEl.textContent = "Provisional";
      badgeEl.dataset.state = "provisional";
    } else {
      badgeEl.hidden = false;
      badgeEl.textContent = "Published";
      badgeEl.dataset.state = "published";
    }

    stateEl.textContent = stateLine(region);
    const note = noteFor(region);
    noteEl.textContent = note;
    noteEl.hidden = note === "";

    cellsTitle.textContent = region.root
      ? "The world's eight regions"
      : "Child cells";
    cellsCount.textContent = `${region.freeCount} free of 8`;
    cellsList.replaceChildren(...region.children.map(renderCellRow));
    cellsEmpty.hidden = true;
    cellsEmpty.textContent = "";
    cellWarning.hidden = true;
    cellWarning.textContent = "";

    assignButton.disabled = region.freeCount === 0;
    assignButton.textContent =
      region.freeCount === 0
        ? "Every slot is taken"
        : "Assign a child region…";
    assignButton.hidden = deps.onAssign === undefined;

    // A re-resolve clears the selection in `resolveZone`; keep the action and
    // warning in step with it even when a caller renders without resetting.
    paintSelectionAction();

    announce(
      `${region.root ? "The world" : `Region ${address}`} loaded. ${region.freeCount} free of 8.`,
    );
  }

  function renderCellRow(child: ChildRegion): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "map-cell-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "region-cell-row map-cell-row";
    button.dataset.slot = String(child.slot);
    button.dataset.state = child.occupied;
    button.dataset.provisional = String(child.provisional);
    button.dataset.selected = String(child.slot === selectedSlot);
    button.setAttribute("aria-pressed", String(child.slot === selectedSlot));

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
    meta.textContent = childMetaText(child);
    // The button's accessible name is the compact "Slot / cell / address /
    // state" sentence; the population line is decorative repetition.
    meta.setAttribute("aria-hidden", "true");

    body.append(line, meta);

    const state = document.createElement("span");
    state.className = `region-cell-state region-cell-state--${child.occupied}`;
    state.textContent = cellStateText(child.occupied);

    button.append(digit, body, state);
    if (child.provisional) {
      const provisional = document.createElement("span");
      provisional.className = "sr-only";
      provisional.textContent = ", provisional";
      button.append(provisional);
    }
    button.addEventListener("click", () => selectChild(child));
    item.append(button);
    return item;
  }

  function selectedChild(): ChildRegion | null {
    if (currentRegion === null || selectedSlot === null) return null;
    return (
      currentRegion.children.find((child) => child.slot === selectedSlot) ??
      null
    );
  }

  /**
   * Show the inline action only for a free selected slot. A taken row still
   * selects (so the sidebar can be inspected), but it never offers the
   * editor; `#map-cell-warning` says why.
   */
  function paintSelectionAction(): void {
    const child = selectedChild();
    const action = selectionAction(child);
    // One primary action: the direct assignment while a free cell is selected,
    // otherwise the guided dialog. Both remain available by keyboard.
    assignButton.className =
      action === null ? "button button--primary" : "button button--quiet";
    if (action === null) {
      assignSelectedButton.hidden = true;
      assignSelectedButton.disabled = true;
      assignSelectedButton.textContent = "";
      if (child !== null && child.occupied !== "free") {
        cellWarning.textContent = `Slot ${child.slot + 1} is taken, so it cannot take a new child.`;
        cellWarning.hidden = false;
      } else {
        cellWarning.hidden = true;
        cellWarning.textContent = "";
      }
      return;
    }
    assignSelectedButton.hidden = false;
    assignSelectedButton.disabled = false;
    assignSelectedButton.textContent = action.label;
    cellWarning.hidden = true;
    cellWarning.textContent = "";
  }

  function selectChild(child: ChildRegion): void {
    if (currentRegion === null) return;
    selectedSlot = child.slot;
    for (const button of cellsList.querySelectorAll<HTMLButtonElement>(
      ".map-cell-row",
    )) {
      const selected = Number(button.dataset.slot) === child.slot;
      button.dataset.selected = String(selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    drawRegion(currentRegion, selectedSlot);
    paintSelectionAction();
    setStatus(selectionStatusText(child));
  }

  function cellLabelsVisible(): boolean {
    // Phone widths cannot fit eight centred labels without clipping them; the
    // sidebar list carries the letters instead.
    return (
      typeof window === "undefined" ||
      !window.matchMedia("(max-width: 560px)").matches
    );
  }

  function drawRegion(
    region: ZoneRegion,
    selected: number | null = null,
  ): void {
    if (stage === null) return;
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
      selected === null
        ? null
        : (region.children.find((child) => child.slot === selected) ?? null);

    for (const child of region.children) {
      if (child.row === null || child.provisional) continue;
      if (child.slot === selected) {
        stage.drawSelection(child.row);
      } else {
        stage.addCell(
          child.row,
          `region-cell region-cell--${child.occupied === "free" ? "free" : "taken"}`,
        );
      }
      if (cellLabelsVisible()) {
        stage.addLabel(child.row, child.letter, "region-digit");
      }
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
      stage.addLabel(
        provisionalBase,
        selectedChild?.provisional
          ? `Slot ${selectedChild.slot + 1} · ${selectedChild.address}`
          : region.provisional
            ? "Provisional"
            : `+${provisionalChildren.length} provisional`,
        "region-note",
        [110, 20],
      );
    }

    stage.fitRows(focusRows, { padding: [28, 28], maxZoom: 8 });
  }

  async function resolveZone(): Promise<void> {
    const request = ++zoneGeneration;
    setPanelBusy(true);
    setStatus("Reading your zone's region…");
    clearBadge();
    addressEl.textContent = "—";
    lettersEl.textContent = "";
    stateEl.textContent = "";
    noteEl.hidden = true;
    noteEl.textContent = "";
    chainList.replaceChildren();
    cellsList.replaceChildren();
    cellsCount.textContent = "";
    cellsEmpty.hidden = true;
    cellWarning.hidden = true;
    assignButton.disabled = true;

    let address: string | null = null;
    try {
      address = await deps.readAddress();
    } catch (error) {
      if (request !== zoneGeneration) return;
      setPanelBusy(false);
      setStatus(`Could not read your address: ${errorMessage(error)}`);
      return;
    }
    if (request !== zoneGeneration) return;
    if (address === null) {
      addressEl.textContent = "—";
      stateEl.textContent =
        "Your address is not settled yet, so there is no region to show.";
      cellsEmpty.hidden = false;
      cellsEmpty.textContent = "The child cells appear when your address settles.";
      setPanelBusy(false);
      setStatus("Your address is not settled yet.");
      return;
    }

    try {
      const rows = deps.readChain
        ? await deps.readChain(address)
        : deriveChain(address);
      if (request !== zoneGeneration) return;
      renderChain(address, rows);

      const dataset = await openRegionDataset();
      const region = await resolveZoneRegion(
        dataset,
        address,
        deps.readSlots(),
      );
      if (request !== zoneGeneration) return;
      currentRegion = region;
      selectedSlot = null;
      renderZone(region, address);
      if (tab === "zone" || lastPlace === null) drawRegion(region);
      setPanelBusy(false);
      setStatus("");
      deps.onResolved?.(region);
    } catch (error) {
      if (request !== zoneGeneration) return;
      setPanelBusy(false);
      cellsList.replaceChildren();
      cellsEmpty.hidden = false;
      cellsEmpty.textContent = "The child cells could not be loaded.";
      setStatus(messageForZone(error));
    }
  }

  async function showPoint(lat: number, lng: number): Promise<void> {
    if (tab !== "place") return;
    const request = ++placeGeneration;
    placeResult.hidden = true;
    setStatus("Looking up the region…");
    try {
      const dataset = await openRegionDataset();
      const resolved = await dataset.resolve(lat, lng);
      if (request !== placeGeneration) return;
      lastPlace = resolved;
      renderPlace(resolved);
      drawPlace(resolved);
      setStatus("");
    } catch (error) {
      if (request !== placeGeneration) return;
      placeResult.hidden = true;
      setStatus(messageFor(error));
    }
  }

  function renderPlace(resolved: ResolvedCell): void {
    const row = resolved.row;
    pathEl.textContent = row.letters;
    octalEl.textContent = row.path.join("");
    depthEl.textContent = String(row.path.length);
    boundsEl.textContent =
      `${format(row.minLat)}, ${format(row.minLon)} – ` +
      `${format(row.maxLat)}, ${format(row.maxLon)}`;
    populationEl.textContent = numberFormat.format(row.population);

    const rows = resolved.children.map((child) => {
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
      return tr;
    });
    childrenBody.replaceChildren(...rows);
    placeResult.hidden = false;
  }

  function drawPlace(resolved: ResolvedCell): void {
    if (stage === null) return;
    stage.clear();
    stage.addCell(resolved.row, "region-cell region-cell--own");
    for (const child of resolved.children) {
      if (!child.row) continue;
      stage.addCell(child.row, "region-cell region-cell--child");
      if (cellLabelsVisible()) {
        stage.addLabel(child.row, child.letters, "region-digit");
      }
    }
    stage.fitRows([resolved.row], { padding: [28, 28], maxZoom: 8 });
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

  function format(value: number): string {
    return value.toFixed(3);
  }

  async function open(
    options: { tab?: MapPageTab } = {},
  ): Promise<void> {
    const request = ++openGeneration;
    opened = true;
    showTab(options.tab ?? tab, false);
    void ensureStage();
    placeResult.hidden = true;
    lastPlace = null;
    await resolveZone();
    if (request !== openGeneration) return;
    title.focus({ preventScroll: true });
  }

  function close(): void {
    opened = false;
    zoneGeneration += 1;
    placeGeneration += 1;
    openGeneration += 1;
    stage?.destroy();
    stage = null;
    selectedSlot = null;
    currentRegion = null;
  }

  function refresh(): void {
    if (!opened) return;
    // Resolve even while the place tab is open: the zone sidebar and the map
    // context must survive a board update that lands after the first paint.
    void resolveZone();
  }

  tabZone.addEventListener("click", () => showTab("zone", false));
  tabPlace.addEventListener("click", () => showTab("place", false));
  tabs.addEventListener("keydown", (event) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const next: MapPageTab =
      event.key === "ArrowLeft" || event.key === "Home" ? "zone" : "place";
    showTab(next, true);
  });

  placeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const lat = Number(latInput.value);
    const lng = Number(lngInput.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setStatus("Enter a latitude and longitude.");
      return;
    }
    void showPoint(lat, lng);
  });

  findPlaceButton.addEventListener("click", () => {
    showTab("place", false);
    latInput.focus({ preventScroll: true });
  });

  assignButton.addEventListener("click", () => {
    deps.onAssign?.();
  });

  assignSelectedButton.addEventListener("click", () => {
    const child = selectedChild();
    // Re-check here: a stale click must not hand a taken slot to the editor.
    if (child === null || selectionAction(child) === null) return;
    deps.onSelectCell?.(child.slot, child);
  });

  zoomInButton.addEventListener("click", () => stage?.zoomIn());
  zoomOutButton.addEventListener("click", () => stage?.zoomOut());
  zoomWorldButton.addEventListener("click", () => stage?.setWorld());
  canvas.addEventListener("click", handleCanvasClick);

  backButton.addEventListener("click", () => {
    deps.onBack?.();
  });

  return { open, close, refresh, tab: () => tab };
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
