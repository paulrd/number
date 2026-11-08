/**
 * Discovery surface for a `?root=` invite (P4c2).
 *
 * The dialog is a thin DOM view over `region/onboarding.ts`: validate a root,
 * pick a point, show the walk to the target, preview the assigned cell, and
 * write one signed request into the target's candidate room. The map is loaded
 * lazily and is decorative; the coordinate form and the lists are the keyboard
 * path.
 */

import type { BoardSnapshot } from "./board";
import type { CandidateTransport } from "./candidate-client";
import {
  CANDIDATE_MAX_NOTE_BYTES,
  CANDIDATE_MAX_REQUESTS,
  candidateRequestId,
  isAccepting,
  textToCandidateNote,
  type CandidateStateV1,
} from "./candidate-state";
import {
  BlobReader,
  ContractSource,
  FixtureSource,
  contractKeyFromInstance,
  type RegionSource,
} from "./region/source";
import {
  REGIONS_MANIFEST_CODE_HASH,
  REGIONS_MANIFEST_INSTANCE,
} from "./region/constants";
import { RegionDataset } from "./region/dataset";
import { buildFixture } from "./region/fixture";
import {
  findTarget,
  parseRootInput,
  validateRoot,
  type ChainZone,
  type MatchResult,
  type ZoneReader,
} from "./region/onboarding";
import { resolveZoneRegion, type SlotOccupancy } from "./region/zone-region";
import type { RegionRow } from "./region/wire";
import { errorMessage, shorten, utf8Length } from "./util";
import type { LatLngExpression, LatLngTuple, LayerGroup, Map } from "leaflet";
import type { GeometryCollection, Topology } from "topojson-specification";

type LeafletModule = typeof import("leaflet");
type TargetMatch = Extract<MatchResult, { kind: "target" }>;
type SaturatedMatch = Extract<MatchResult, { kind: "saturated" }>;

export interface OnboardingPanelDeps {
  /** Read one zone by owner id; the onboarding walk uses board snapshots. */
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
  /** Candidate-room transport for the target's queue and the request write. */
  transport: CandidateTransport;
  /** The requester's own owner id, or null while the identity is not ready. */
  selfId(): string | null;
  announce(message: string): void;
  /** Called when the dialog closes or the request is sent: drop `?root=`. */
  onSettled(): void;
}

export interface OnboardingPanel {
  /** Open with a raw link/id to prefill, or null for an empty field. */
  open(prefill?: string | null): void;
  close(): void;
}

const NOTE_LIMIT = CANDIDATE_MAX_NOTE_BYTES;
const QUEUE_LIMIT = CANDIDATE_MAX_REQUESTS;
const WORLD_VIEW: LatLngExpression = [20, 0];
const WORLD_ZOOM = 1;
const LETTERS = "abcdefgh";

let map: Map | null = null;
let layer: LayerGroup | null = null;
let leaflet: LeafletModule | null = null;

/** `12 / 256 bytes`, or a warning when the note is too long. */
export function noteByteLabel(note: string): string {
  const bytes = utf8Length(note);
  if (bytes > NOTE_LIMIT) {
    return `${bytes} / ${NOTE_LIMIT} bytes — too long`;
  }
  return `${bytes} / ${NOTE_LIMIT} bytes`;
}

/** `world` for the empty cell, otherwise `cell 012`. */
export function formatWantCell(wantCell: string): string {
  return wantCell === "" ? "world" : `cell ${wantCell}`;
}

/** `root` for the empty address, otherwise the octal address. */
export function chainAddress(address: string): string {
  return address === "" ? "root" : address;
}

/** A local sentence for the reasons `validateRoot` returns. */
export function rootErrorText(reason: string): string {
  if (/mutual parent/.test(reason)) {
    return "That id belongs to a child zone, not a root. Ask for the root's link instead.";
  }
  if (/unreadable/.test(reason)) {
    return "That zone could not be read. Check the link or root id and try again.";
  }
  if (/64 lowercase hex/.test(reason)) {
    return "A root id is 64 lowercase hex characters.";
  }
  return `That root could not be used: ${reason}.`;
}

/**
 * Accepting state and queue count for the candidate room, in one line. A
 * missing state is the contract's initial state: accepting, with no queue.
 */
export function candidateStatusLine(state: CandidateStateV1 | null): string {
  const accepting = state === null || isAccepting(state);
  const waiting = state?.requests.length ?? 0;
  const verb = accepting ? "Accepting requests" : "Not accepting requests";
  return `${verb} · ${waiting} of ${QUEUE_LIMIT} waiting`;
}

/** A readable request failure; no contract detail is hidden in a toast. */
export function requestErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "connection") {
    return "Could not reach the zone's request queue. Check your connection and try again.";
  }
  if (code === "write") {
    return "The zone did not accept the request. Try again in a moment.";
  }
  if (code === "sign") {
    return "The request could not be signed. Make sure your identity is ready, then try again.";
  }
  if (code === "read") {
    return "The request was sent, but its confirmation could not be read. Reopen this screen to check.";
  }
  if (code === "wasm" || code === "config") {
    return "The request room could not be prepared. Rebuild the app and try again.";
  }
  return `The request could not be sent: ${errorMessage(error)}`;
}

/**
 * The request id of the newest queue entry matching this requester, cell and
 * note. Offline and online transports both return the state after the write.
 */
export function requestIdFor(
  state: CandidateStateV1,
  requester: string,
  wantCell: string,
  note: string,
): string | null {
  const encoded = textToCandidateNote(note);
  let best: { id: string; time: number } | null = null;
  for (const request of state.requests) {
    if (
      request.requester !== requester ||
      request.want_cell !== wantCell ||
      request.note !== encoded
    ) {
      continue;
    }
    const id = candidateRequestId(request);
    if (best === null || request.time >= best.time) {
      best = { id, time: request.time };
    }
  }
  if (best !== null) return best.id;

  // A non-canonical note encoding is unlikely, but the id still comes from the
  // requester's newest entry rather than a guessed value.
  let newest: { id: string; time: number } | null = null;
  for (const request of state.requests) {
    if (request.requester !== requester) continue;
    const id = candidateRequestId(request);
    if (newest === null || request.time >= newest.time) {
      newest = { id, time: request.time };
    }
  }
  return newest?.id ?? null;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function isOffline(): boolean {
  return import.meta.env.VITE_OFFLINE_MODE === "1";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function occupancyFor(zone: ChainZone): SlotOccupancy[] {
  const free = new Set(zone.freeSlots);
  return Array.from({ length: 8 }, (_, slot) =>
    free.has(slot) ? "free" : "taken",
  );
}

export function createOnboardingPanel(
  deps: OnboardingPanelDeps,
): OnboardingPanel {
  const dialog = byId<HTMLDialogElement>("join-dialog");
  const title = byId<HTMLHeadingElement>("join-title");
  const closeButton = byId<HTMLButtonElement>("join-close");

  const rootStep = byId<HTMLElement>("join-root-step");
  const rootTitle = byId<HTMLHeadingElement>("join-root-title");
  const rootForm = byId<HTMLFormElement>("join-root-form");
  const rootInput = byId<HTMLInputElement>("join-root-input");
  const rootContinue = byId<HTMLButtonElement>("join-root-continue");
  const rootError = byId<HTMLElement>("join-root-error");
  const rootStatus = byId<HTMLElement>("join-root-status");

  const discovery = byId<HTMLElement>("join-discovery");
  const placeTitle = byId<HTMLHeadingElement>("join-place-title");
  const placeForm = byId<HTMLFormElement>("join-place-form");
  const latInput = byId<HTMLInputElement>("join-lat");
  const lngInput = byId<HTMLInputElement>("join-lng");
  const pointButton = byId<HTMLButtonElement>("join-point");
  const placeStatus = byId<HTMLElement>("join-place-status");
  const placeError = byId<HTMLElement>("join-place-error");
  const mapElement = byId<HTMLElement>("join-map");
  const mapFallback = byId<HTMLElement>("join-map-fallback");

  const loading = byId<HTMLElement>("join-loading");
  const result = byId<HTMLElement>("join-result");
  const resultTitle = byId<HTMLHeadingElement>("join-result-title");
  const resultLede = byId<HTMLElement>("join-result-lede");
  const chainList = byId<HTMLOListElement>("join-chain");

  const targetArea = byId<HTMLElement>("join-target-area");
  const targetId = byId<HTMLElement>("join-target-id");
  const targetAddress = byId<HTMLElement>("join-target-address");
  const targetSlots = byId<HTMLElement>("join-target-slots");
  const targetAccepting = byId<HTMLElement>("join-target-accepting");

  const assignedBadge = byId<HTMLElement>("join-assigned-badge");
  const assignedSlot = byId<HTMLElement>("join-assigned-slot");
  const assignedDigit = byId<HTMLElement>("join-assigned-digit");
  const assignedAddress = byId<HTMLElement>("join-assigned-address");
  const assignedWarning = byId<HTMLElement>("join-assigned-warning");

  const requestForm = byId<HTMLFormElement>("join-request-form");
  const noteInput = byId<HTMLTextAreaElement>("join-note");
  const noteCount = byId<HTMLElement>("join-note-count");
  const publicId = byId<HTMLElement>("join-public-id");
  const publicCell = byId<HTMLElement>("join-public-cell");
  const publicNote = byId<HTMLElement>("join-public-note");
  const submitButton = byId<HTMLButtonElement>("join-submit");
  const requestError = byId<HTMLElement>("join-request-error");
  const requestBlocked = byId<HTMLElement>("join-request-blocked");
  const requestSuccess = byId<HTMLElement>("join-request-success");
  const requestId = byId<HTMLElement>("join-request-id");

  const saturatedArea = byId<HTMLElement>("join-saturated-area");
  const saturatedTitle = byId<HTMLHeadingElement>("join-saturated-title");
  const saturatedReason = byId<HTMLElement>("join-saturated-reason");
  const tryAnother = byId<HTMLButtonElement>("join-try-another");

  let rootId: string | null = null;
  let currentMatch: TargetMatch | null = null;
  let step: "root" | "place" | "result" = "root";
  let flowGeneration = 0;
  let candidateGeneration = 0;
  let busy = false;
  let pending = false;
  let submitted = false;

  type CandidateRead =
    | { kind: "loading" }
    | { kind: "ready"; state: CandidateStateV1 | null }
    | { kind: "error" };
  let candidateRead: CandidateRead = { kind: "loading" };

  let datasetPromise: Promise<RegionDataset> | null = null;
  let mapPromise: Promise<boolean> | null = null;
  let lastFocus: HTMLElement | null = null;

  const reader: ZoneReader = async (ownerId) => {
    const snapshot = await deps.readBoard(ownerId);
    if (snapshot === null) return null;
    return { ownerId: snapshot.ownerId, state: snapshot.state };
  };

  function setStep(next: "root" | "place" | "result", focus: boolean): void {
    step = next;
    rootStep.hidden = next !== "root";
    discovery.hidden = next === "root";
    result.hidden = next !== "result";
    if (next !== "result") {
      targetArea.hidden = true;
      saturatedArea.hidden = true;
    }
    if (next === "place") loading.hidden = true;
    if (next === "root") {
      loading.hidden = true;
      clearMap();
    }
    if (focus) {
      const heading =
        next === "root" ? rootTitle : next === "place" ? placeTitle : resultTitle;
      heading.focus({ preventScroll: false });
    }
  }

  function open(prefill: string | null = null): void {
    flowGeneration += 1;
    candidateGeneration += 1;
    rootId = null;
    currentMatch = null;
    busy = false;
    pending = false;
    submitted = false;
    candidateRead = { kind: "loading" };

    rootInput.value = prefill ?? "";
    rootInput.removeAttribute("aria-invalid");
    rootContinue.textContent = "Continue";
    rootError.hidden = true;
    rootError.textContent = "";
    rootStatus.textContent = "";
    placeError.hidden = true;
    placeError.textContent = "";
    placeStatus.textContent = "";
    requestError.hidden = true;
    requestError.textContent = "";
    requestBlocked.hidden = true;
    requestBlocked.textContent = "";
    requestSuccess.hidden = true;
    requestId.textContent = "";
    requestForm.reset();
    noteInput.disabled = false;
    noteInput.value = "";
    latInput.value = "";
    lngInput.value = "";
    chainList.replaceChildren();
    targetArea.hidden = true;
    saturatedArea.hidden = true;
    loading.hidden = true;
    setStep("root", false);
    updateNote();
    refreshRequestState();
    if (!map || !layer) {
      mapFallback.hidden = true;
      mapElement.dataset.state = "";
    }
    clearMap();

    if (!dialog.open) {
      const active = document.activeElement;
      lastFocus =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      dialog.showModal();
      // showModal() focuses the first control; move focus to the step heading.
      window.requestAnimationFrame(() => {
        if (dialog.open && step === "root") {
          title.focus({ preventScroll: false });
        }
      });
    } else {
      title.focus({ preventScroll: false });
    }

    if (prefill !== null && prefill.trim() !== "") {
      void continueRoot();
    }
  }

  function close(): void {
    if (dialog.open) dialog.close();
  }

  async function continueRoot(): Promise<void> {
    const raw = rootInput.value;
    const id = parseRootInput(raw);
    rootError.hidden = true;
    rootError.textContent = "";
    rootInput.removeAttribute("aria-invalid");
    rootStatus.textContent = "";

    if (id === null) {
      showRootError(
        "That is not a root link or id. Paste the link you were given, or the 64-character root id.",
      );
      rootInput.focus({ preventScroll: true });
      return;
    }

    const generation = ++flowGeneration;
    busy = true;
    rootForm.setAttribute("aria-busy", "true");
    rootContinue.disabled = true;
    rootContinue.textContent = "Checking…";
    rootStatus.textContent = "Checking that zone…";

    try {
      const valid = await validateRoot(reader, id);
      if (generation !== flowGeneration) return;
      if (!valid.ok) {
        showRootError(rootErrorText(valid.reason));
        rootInput.focus({ preventScroll: true });
        return;
      }

      rootId = id;
      rootInput.removeAttribute("aria-invalid");
      rootError.hidden = true;
      await preparePlace();
      if (generation !== flowGeneration) return;
      setStep("place", true);
      placeStatus.textContent = "Zone found. Choose where you are.";
    } catch (error) {
      if (generation !== flowGeneration) return;
      showRootError(
        `That zone could not be checked: ${errorMessage(error)}`,
      );
      rootInput.focus({ preventScroll: true });
    } finally {
      if (generation === flowGeneration) {
        busy = false;
        rootForm.setAttribute("aria-busy", "false");
        rootContinue.disabled = false;
        rootContinue.textContent = "Continue";
      }
    }
  }

  function showRootError(message: string): void {
    rootError.textContent = message;
    rootError.hidden = false;
    rootInput.setAttribute("aria-invalid", "true");
    rootContinue.textContent = "Try again";
    rootStatus.textContent = "";
  }

  async function preparePlace(): Promise<void> {
    // The map is lazy: this is the first point at which it can be useful.
    void ensureMap().then((ok) => {
      if (step === "root") return;
      mapFallback.hidden = ok;
      mapElement.dataset.state = ok ? "ready" : "unavailable";
      window.requestAnimationFrame(() => map?.invalidateSize());
    });
    placeError.hidden = true;
    placeError.textContent = "";
  }

  async function ensureDataset(): Promise<RegionDataset> {
    if (datasetPromise === null) {
      datasetPromise = RegionDataset.open(createSource());
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
      throw new Error("Region data is not published yet.");
    }
    return new ContractSource(
      new BlobReader(),
      contractKeyFromInstance(
        REGIONS_MANIFEST_INSTANCE,
        REGIONS_MANIFEST_CODE_HASH,
      ),
    );
  }

  async function ensureMap(): Promise<boolean> {
    if (map !== null && layer !== null) return true;
    if (mapPromise !== null) return mapPromise;

    mapPromise = (async () => {
      try {
        const [module, countriesModule, topojson] = await Promise.all([
          import("leaflet"),
          import("./assets/countries-110m.json"),
          import("topojson-client"),
          import("leaflet/dist/leaflet.css"),
        ]);
        const L = (
          (module as unknown as { default?: LeafletModule }).default ?? module
        ) as LeafletModule;
        leaflet = L;
        map = L.map(mapElement, {
          crs: L.CRS.EPSG4326,
          center: WORLD_VIEW,
          zoom: WORLD_ZOOM,
          minZoom: 1,
          maxZoom: 8,
          worldCopyJump: true,
          attributionControl: false,
          keyboard: false,
          zoomControl: false,
        });
        mapElement.removeAttribute("tabindex");

        const topology = countriesModule.default as unknown as Topology<{
          countries: GeometryCollection;
        }>;
        const geometry = topojson.feature(
          topology,
          topology.objects.countries,
        );
        L.geoJSON(geometry as unknown as GeoJSON.GeoJsonObject, {
          style: () => ({
            className: "join-world",
            weight: 0.5,
            fillOpacity: 1,
          }),
        }).addTo(map);

        layer = L.layerGroup().addTo(map);
        map.on("click", (event) => {
          if (step !== "place" || busy) return;
          latInput.value = String(roundCoordinate(event.latlng.lat));
          lngInput.value = String(roundCoordinate(event.latlng.lng));
          void matchPoint({ lat: event.latlng.lat, lng: event.latlng.lng });
        });
        window.requestAnimationFrame(() => map?.invalidateSize());
        return true;
      } catch {
        map = null;
        layer = null;
        leaflet = null;
        return false;
      } finally {
        mapPromise = null;
      }
    })();
    return mapPromise;
  }

  function roundCoordinate(value: number): number {
    return Math.round(value * 1e5) / 1e5;
  }

  function clearMap(): void {
    layer?.clearLayers();
  }

  async function matchPoint(next: {
    lat: number;
    lng: number;
  }): Promise<void> {
    if (rootId === null) return;
    const generation = ++flowGeneration;
    const targetRoot = rootId;
    busy = true;
    placeError.hidden = true;
    placeError.textContent = "";
    placeStatus.textContent = "Finding the zone that will take you…";
    deps.announce("Finding the zone that will take you.");
    discovery.setAttribute("aria-busy", "true");
    pointButton.disabled = true;
    loading.hidden = false;
    setStep("place", false);
    loading.hidden = false;
    result.hidden = true;
    targetArea.hidden = true;
    saturatedArea.hidden = true;

    try {
      const dataset = await ensureDataset();
      const found = await findTarget(reader, dataset, targetRoot, next);
      if (generation !== flowGeneration) return;

      if (found.kind === "invalid-root") {
        rootId = null;
        showRootError(rootErrorText(found.reason));
        setStep("root", false);
        rootInput.focus({ preventScroll: true });
        return;
      }

      currentMatch = found.kind === "target" ? found : null;
      candidateRead =
        found.kind === "target" ? { kind: "loading" } : { kind: "error" };
      submitted = false;
      pending = false;
      requestForm.reset();
      noteInput.value = "";
      noteInput.disabled = false;
      requestError.hidden = true;
      requestError.textContent = "";
      requestBlocked.hidden = true;
      requestSuccess.hidden = true;
      requestId.textContent = "";
      updateNote();

      renderResult(found);
      setStep("result", true);
      resultTitle.focus({ preventScroll: false });
      void drawMatch(found, dataset, next);

      if (found.kind === "target") {
        const target = found.chain[found.chain.length - 1]!;
        refreshAccepting();
        refreshRequestState();
        void loadCandidate(target.ownerId);
      } else {
        refreshRequestState();
      }
      placeStatus.textContent =
        found.kind === "target"
          ? "Target found. Review the region and send a request."
          : "This branch cannot take you.";
    } catch (error) {
      if (generation !== flowGeneration) return;
      placeStatus.textContent = "";
      placeError.textContent = `The zone match could not be read: ${errorMessage(error)}`;
      placeError.hidden = false;
    } finally {
      if (generation === flowGeneration) {
        busy = false;
        loading.hidden = true;
        discovery.setAttribute("aria-busy", "false");
        pointButton.disabled = false;
        refreshRequestState();
      }
    }
  }

  function renderResult(found: TargetMatch | SaturatedMatch): void {
    result.hidden = false;
    loading.hidden = true;
    renderChain(found.chain, found.kind === "target");
    if (found.kind === "target") {
      targetArea.hidden = false;
      saturatedArea.hidden = true;
      resultLede.textContent =
        found.chain.length === 1
          ? "The first zone with a free slot is the one that can take you."
          : "The walk stops at the first zone on your path with a free slot.";
      renderTarget(found);
    } else {
      targetArea.hidden = true;
      saturatedArea.hidden = false;
      resultLede.textContent =
        "No zone on this branch has a free slot for you.";
      renderSaturated(found);
    }
  }

  function renderChain(chain: readonly ChainZone[], hasTarget: boolean): void {
    const rows = chain.map((zone, index) => {
      const row = document.createElement("li");
      row.className = "onboarding-chain-row";
      const isTarget = hasTarget && index === chain.length - 1;
      row.dataset.target = String(isTarget);
      row.dataset.last = String(index === chain.length - 1);

      const marker = document.createElement("span");
      marker.className = "onboarding-chain-marker";
      marker.setAttribute("aria-hidden", "true");

      const body = document.createElement("span");
      body.className = "onboarding-chain-body";

      const line = document.createElement("span");
      line.className = "onboarding-chain-line";
      const address = document.createElement("code");
      address.className = "onboarding-chain-address";
      address.textContent = chainAddress(zone.address);
      line.append(address);
      if (isTarget) {
        const tag = document.createElement("span");
        tag.className = "onboarding-chain-tag";
        tag.textContent = "your target";
        line.append(tag);
      } else if (index === chain.length - 1) {
        const tag = document.createElement("span");
        tag.className = "onboarding-chain-tag onboarding-chain-tag--stopped";
        tag.textContent = "full";
        line.append(tag);
      }

      const meta = document.createElement("span");
      meta.className = "onboarding-chain-meta";
      meta.textContent =
        `${zone.occupied} of 8 slots taken` +
        (zone.freeSlots.length > 0
          ? ` · ${zone.freeSlots.length} free`
          : " · full");

      body.append(line, meta);
      row.append(marker, body);
      return row;
    });
    chainList.replaceChildren(...rows);
  }

  function renderTarget(found: TargetMatch): void {
    const target = found.chain[found.chain.length - 1]!;
    const assigned = found.assigned;

    targetId.textContent = shorten(target.ownerId);
    targetId.title = target.ownerId;
    targetId.setAttribute("aria-label", `Target owner id ${target.ownerId}`);
    targetAddress.textContent =
      target.address === ""
        ? "the root zone"
        : `at address ${target.address}`;
    targetSlots.textContent = `${target.occupied} / 8 slots taken`;
    refreshAccepting();

    const slot = assigned.slot;
    assignedSlot.textContent = `Slot ${slot + 1}`;
    assignedDigit.textContent = `zero-based digit ${slot}, cell ${LETTERS[slot]}`;
    assignedAddress.textContent =
      assigned.address === "" ? "root" : assigned.address;
    assignedBadge.hidden = false;
    assignedBadge.textContent = assigned.published ? "Published" : "Provisional";
    assignedBadge.dataset.state = assigned.published ? "published" : "provisional";
    const warning = assigned.warning;
    assignedWarning.textContent = warning ?? "";
    assignedWarning.hidden = warning === null;
    assignedWarning.classList.toggle("is-hint", warning === null);

    updatePublicSummary();
    updateNote();
    refreshRequestState();
  }

  function renderSaturated(found: SaturatedMatch): void {
    const last = found.chain[found.chain.length - 1];
    const where = last ? chainAddress(last.address) : "the root";
    saturatedTitle.textContent =
      found.reason === "full" ? "This branch is full" : "This branch is broken";
    saturatedReason.textContent =
      found.reason === "full"
        ? `Every zone from the root to ${where} has all eight slots taken.`
        : `The chain from the root stops at ${where}: the next zone is missing or its parent does not point back.`;
  }

  function updatePublicSummary(): void {
    const found = currentMatch;
    if (!found) return;
    const requester = deps.selfId();
    publicId.textContent = requester ?? "your identity is not ready";
    publicCell.textContent = formatWantCell(found.wantCell);
    const note = noteInput.value;
    publicNote.textContent = note.trim() === "" ? "(no note)" : note;
  }

  function updateNote(): void {
    noteCount.textContent = noteByteLabel(noteInput.value);
    noteCount.classList.toggle(
      "is-warning",
      utf8Length(noteInput.value) > NOTE_LIMIT,
    );
    updatePublicSummary();
    refreshRequestState();
  }

  function refreshAccepting(): void {
    if (currentMatch === null) {
      targetAccepting.textContent = "";
      return;
    }
    if (candidateRead.kind === "loading") {
      targetAccepting.textContent = "Checking the zone's request queue…";
      return;
    }
    if (candidateRead.kind === "error") {
      targetAccepting.textContent =
        "Accepting unknown — the request queue could not be read. You can still send a request.";
      return;
    }
    targetAccepting.textContent = candidateStatusLine(candidateRead.state);
  }

  async function loadCandidate(ownerId: string): Promise<void> {
    const generation = ++candidateGeneration;
    try {
      const state = await deps.transport.read(ownerId);
      if (generation !== candidateGeneration) return;
      candidateRead = { kind: "ready", state };
    } catch {
      if (generation !== candidateGeneration) return;
      candidateRead = { kind: "error" };
    }
    refreshAccepting();
    refreshRequestState();
  }

  function blockedReason(): string | null {
    if (currentMatch === null) return "Choose a point first.";
    if (deps.selfId() === null) {
      return "Your identity is not ready, so a signed request cannot be sent yet.";
    }
    if (utf8Length(noteInput.value) > NOTE_LIMIT) {
      return `The note is longer than ${NOTE_LIMIT} bytes. Shorten it to send the request.`;
    }
    if (candidateRead.kind === "loading") {
      return "Checking whether the zone is accepting requests…";
    }
    if (candidateRead.kind === "error") return null;
    if (
      candidateRead.state !== null &&
      !isAccepting(candidateRead.state)
    ) {
      return "This zone is not accepting new requests right now. Try again later or ask the owner directly.";
    }
    return null;
  }

  function refreshRequestState(): void {
    if (pending) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending…";
      requestForm.setAttribute("aria-busy", "true");
      noteInput.disabled = true;
      return;
    }
    requestForm.setAttribute("aria-busy", "false");
    if (submitted) {
      submitButton.disabled = true;
      submitButton.textContent = "Request sent";
      noteInput.disabled = true;
      requestBlocked.hidden = true;
      requestBlocked.textContent = "";
      return;
    }
    noteInput.disabled = false;
    submitButton.textContent = "Send join request";
    const blocked = blockedReason();
    submitButton.disabled = blocked !== null;
    requestBlocked.textContent = blocked ?? "";
    requestBlocked.hidden = blocked === null;
  }

  async function submitRequest(): Promise<void> {
    const match = currentMatch;
    if (match === null || pending || submitted) return;
    if (blockedReason() !== null) return;
    const requester = deps.selfId();
    if (requester === null) return;
    const target = match.chain[match.chain.length - 1]!;
    const note = noteInput.value;
    const generation = ++flowGeneration;

    pending = true;
    requestError.hidden = true;
    requestError.textContent = "";
    refreshRequestState();

    try {
      const state = await deps.transport.request(target.ownerId, {
        wantCell: match.wantCell,
        note,
      });
      if (generation !== flowGeneration) return;
      submitted = true;
      const id =
        requestIdFor(state, requester, match.wantCell, note) ?? "(not reported)";
      requestId.textContent = id;
      requestSuccess.hidden = false;
      deps.onSettled();
      deps.announce(
        "Join request sent. Waiting for the owner to interview you.",
      );
    } catch (error) {
      if (generation !== flowGeneration) return;
      requestError.textContent = requestErrorText(error);
      requestError.hidden = false;
    } finally {
      if (generation === flowGeneration) {
        pending = false;
        refreshRequestState();
      }
    }
  }

  async function drawMatch(
    found: TargetMatch | SaturatedMatch,
    dataset: RegionDataset,
    at: { lat: number; lng: number },
  ): Promise<void> {
    const ok = await ensureMap();
    if (!ok || map === null || layer === null || leaflet === null) {
      mapFallback.hidden = false;
      mapElement.dataset.state = "unavailable";
      return;
    }
    const L = leaflet;
    layer.clearLayers();
    const rows: RegionRow[] = [];
    const targetIndex = found.kind === "target" ? found.chain.length - 1 : -1;

    for (let index = 0; index < found.chain.length; index += 1) {
      const zone = found.chain[index]!;
      try {
        const region = await resolveZoneRegion(
          dataset,
          zone.address,
          occupancyFor(zone),
        );
        if (region.cell !== null) {
          const cls =
            index === targetIndex
              ? "join-cell join-cell--target"
              : "join-cell join-cell--chain";
          addCell(L, region.cell, cls);
          rows.push(region.cell);
        }
        if (index === targetIndex && found.kind === "target") {
          const child = region.children[found.assigned.slot];
          // A provisional cell has no geometry. Never invent one.
          if (child?.row) {
            addCell(L, child.row, "join-cell join-cell--assigned");
            rows.push(child.row);
          }
        }
      } catch {
        // A dataset problem is not fatal here: the list is the record.
      }
    }

    L.circleMarker([at.lat, at.lng], {
      radius: 6,
      className: "join-point",
      interactive: false,
    }).addTo(layer);

    if (rows.length > 0) {
      const corners: LatLngTuple[] = [];
      for (const row of rows) {
        corners.push([row.minLat, row.minLon], [row.maxLat, row.maxLon]);
      }
      corners.push([at.lat, at.lng]);
      map.fitBounds(L.latLngBounds(corners), {
        padding: [18, 18],
        maxZoom: 7,
        animate: !prefersReducedMotion(),
      });
    } else {
      map.setView([at.lat, at.lng], 4, {
        animate: !prefersReducedMotion(),
      });
    }
    window.requestAnimationFrame(() => map?.invalidateSize());
  }

  function addCell(
    L: LeafletModule,
    row: RegionRow,
    className: string,
  ): void {
    if (layer === null) return;
    L.rectangle(
      [
        [row.minLat, row.minLon],
        [row.maxLat, row.maxLon],
      ],
      { className, interactive: false },
    ).addTo(layer);
  }

  function resetToRoot(): void {
    flowGeneration += 1;
    candidateGeneration += 1;
    rootId = null;
    currentMatch = null;
    busy = false;
    pending = false;
    submitted = false;
    candidateRead = { kind: "loading" };
    rootStep.hidden = false;
    discovery.hidden = true;
    loading.hidden = true;
    result.hidden = true;
    targetArea.hidden = true;
    saturatedArea.hidden = true;
    placeError.hidden = true;
    placeError.textContent = "";
    placeStatus.textContent = "";
    requestError.hidden = true;
    requestError.textContent = "";
    requestBlocked.hidden = true;
    requestBlocked.textContent = "";
    requestSuccess.hidden = true;
    requestId.textContent = "";
    requestForm.reset();
    noteInput.value = "";
    latInput.value = "";
    lngInput.value = "";
    updateNote();
    clearMap();
    setStep("root", false);
    rootInput.focus({ preventScroll: true });
    rootInput.select();
  }

  function handlePlaceSubmit(): void {
    if (busy) return;
    const latText = latInput.value.trim();
    const lngText = lngInput.value.trim();
    const lat = Number(latText);
    const lng = Number(lngText);
    if (latText === "" || lngText === "") {
      showPlaceError("Enter a latitude and longitude, or click the map.");
      return;
    }
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      showPlaceError(
        "Enter a latitude between -90 and 90 and a longitude between -180 and 180.",
      );
      return;
    }
    void matchPoint({ lat, lng });
  }

  function showPlaceError(message: string): void {
    placeError.textContent = message;
    placeError.hidden = false;
    placeStatus.textContent = "";
  }

  rootForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!busy) void continueRoot();
  });
  placeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handlePlaceSubmit();
  });
  requestForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitRequest();
  });
  noteInput.addEventListener("input", updateNote);
  rootInput.addEventListener("input", () => {
    rootInput.removeAttribute("aria-invalid");
    rootError.hidden = true;
    rootError.textContent = "";
    rootContinue.textContent = "Continue";
  });
  closeButton.addEventListener("click", close);
  tryAnother.addEventListener("click", resetToRoot);

  dialog.addEventListener("close", () => {
    flowGeneration += 1;
    candidateGeneration += 1;
    pending = false;
    deps.onSettled();
    const target = lastFocus;
    lastFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  return { open, close };
}
