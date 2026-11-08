# Map page — design and implementation contract

Status: pass 1 implemented, 2026-11-08. This document is the authority for the
map page; it supersedes the map paragraphs in `DESIGN-views.md` and
`DESIGN-regions-p1.md` §9 where they disagree.

Pass 1 delivers the page shell, the shared base map, the view-mode wiring, and
the consolidation of three map implementations into one. The detail layers and
inline assignment are specified here as seams, not built.

---

## 1. Decisions

| # | Decision | Value |
| --- | --- | --- |
| M1 | Where the map lives | A full-screen sub-page of Advanced, `?view=map`. Not a third header tab. |
| M2 | Default surface | Unchanged. `#simple-view` stays map-free; no map node exists inside it. |
| M3 | Identity of the map | One shared base map (`region/map-base.ts`) for the page, the assign/review dialog, and the onboarding embed. |
| M4 | Zoom policy | `minZoom 1`, `maxZoom 11` on the page and dialog; onboarding stays at 8. Zoom is a rendering control, not a claim of extra data. |
| M5 | Detail source | Vendored Natural Earth only. No tiles, no CDN, no API key. |
| M6 | Below the dataset prefix | Never drawn. Provisional cells are shown inside their nearest published ancestor with their own address. |
| M7 | Keyboard path | The sidebar list and the coordinate form are equal to the map, not fallbacks. The canvas is `aria-hidden` and has no focusable Leaflet control. |
| M8 | Dialog scope | Assign and review only. Zone viewing and place lookup moved to the page. |

### Why the dialog's zone/place modes were removed

`openZoneRegion` and `openRegionPicker` had exactly one caller each, both in
Advanced, and both are now the page. Keeping them would mean two live Leaflet
instances, duplicate map chrome, and two ways to show the same address. The
assign and review modes remain because they are transactional: they must close
before the slot editor opens, and their result is a choice, not a destination.

---

## 2. Information architecture

```
header   wordmark + [Advanced] / [Back to the simple view]
main
  section#simple-view      default, map-free
  section#advanced-view    Advanced
  section#map-view         ?view=map, Advanced's sub-page
footer
...dialogs
```

- `ViewMode = "simple" | "advanced" | "map"` (`ui/src/view-mode.ts`).
- The header keeps one control. From Simple it reads `Advanced`; from Advanced
  or Map it reads `Back to the simple view` and `aria-expanded="true"`. A map is
  never a peer of Simple.
- Entry points, all in Advanced's "Where this zone sits":
  - `#region-open` — `Open the map`, zone tab.
  - `#region-place-open` — `Find a place…`, place tab.
- `#add-child-slot` still opens the assign dialog; `#parent-region-map` still
  opens review. Neither navigates.

### URL and history rules

| Transition | History |
| --- | --- |
| Advanced → Map | `pushState(?view=map)`; remember `pushedMapEntry` |
| Map → Advanced, entry pushed | `history.back()` |
| Map → Advanced, direct load | `replaceState(?view=advanced)`, no `history.back()` (never bounces out of the app) |
| Map → Simple (header control) | `replaceState` strips `view` and `place` |
| Advanced → Simple | unchanged from `DESIGN-views.md` |
| Browser Back | `popstate` maps `?view` to the surface; entering Map also opens the page |
| Tab change | `replaceState`: `place=1` while the place tab is open, removed on the zone tab |

`?view=map&place=1` is the only map-specific parameter. It selects the tab; it
is dropped with `replaceState` when the user chooses "This zone". Receive,
join, room and root parameters are untouched.

Focus: entering Map focuses `#map-title`; leaving focuses `#advanced-title` or
`#board-title`. Map is a page, not a dialog, so Escape does nothing and there
is no focus trap. If a future pass wraps it in a dialog, Escape must close and
return focus to the trigger.

Scroll is app-owned (`history.scrollRestoration = "manual"`): entering the map
starts at the top so the site header and `#map-back` are visible; leaving via
Back restores Advanced's scroll position. Without this the map page inherited
Advanced's scroll offset (the title focus uses `preventScroll`).

---

## 3. Page layout contract

```
#map-view.map-page
  header.map-page-head
    button#map-back            ← Advanced
    p.eyebrow                  Where this zone sits
    h2#map-title[tabindex=-1]  Map
  #map-tabs[role=tablist]      This zone | Find a place
  .map-page-body               grid: minmax(0,1fr) 22rem above 1024px
    .map-stage                 sticky above 1024px
      #map-canvas[aria-hidden] #map-canvas-help.sr-only
      #map-controls[role=group] − / World / +
      #map-unavailable         fallback panel
      #map-source              attribution
    aside#map-side
      #map-status[role=status]
      #map-panel-zone[role=tabpanel]
      #map-panel-place[role=tabpanel]
```

### Zone panel, top to bottom

1. Address block: `#map-zone-address` (large mono, `root` or octal),
   `#map-zone-letters` (`cell aacbea`), `#map-zone-badge`.
2. `#map-zone-state`: depth and population, or the provisional sentence.
3. `#map-zone-note`: "Provisional cells are not guessed shapes…".
4. `#map-legend`: Your zone · Free · Taken · Provisional.
5. `#map-chain`: every address prefix from `root` to this zone, current row
   marked. `root → 0 → 03 → 031`.
6. `#map-cells`: eight rows, each a real `<button>` with slot, letter, address,
   published/provisional, population and Free/Taken/Pending. The list is the
   record; selecting a row pans the map and marks it.
7. `#map-assign` (opens the existing assign dialog; disabled with the existing
   "Every slot is taken" reason), `#map-find-place`.

### Place panel

`#map-place-form` (Latitude, Longitude, Show region), then `#region-result`:
path letters, octal address, depth, bounds, population, and the child table
(`not published` where the dataset has no row). Ids are unchanged from the old
dialog place panel, so the copy and tests read the same.

Entering the place tab clears the zone cells and resets the camera to the world,
or redraws the last resolved place. Clicking the canvas fills the latitude and
longitude fields, resolves the point, and draws the resolved cell with a point
marker; the form remains the keyboard path. Switching back to "This zone"
re-fits the zone and clears the place point.

Errors: "No published region covers this point.", "Region data failed verification.", "Region detail
is unavailable right now.".

### Responsive

| Width | Layout | Canvas |
| --- | --- | --- |
| ≥ 1024 px | Two columns, 22rem sidebar, sticky map stage | `min(68vh, 46rem)` |
| 901–1023 px | One column, map first | `clamp(15rem, 42vh, 24rem)` |
| ≤ 900 px | One column, normal app gutters (no full bleed) | same |
| ≤ 560 px | Map first, actions full width, no map digit suppression yet | `clamp(15rem, 40vh, 22rem)` |

Above 1024 px `#map-view` breaks out of the 76rem `.app` measure and caps at
1600 px; the sidebar stays 22rem so the map takes the gain. `#simple-view` and
`#advanced-view` keep their existing widths.

---

## 4. Detail rules

Pass 2 adds three layers without changing the page shell or the country
geometry pipeline. `detail: "full"` (page and assign/review dialog) gets them;
`detail: "compact"` (onboarding) keeps the plain 110m world.

| Layer | Final behaviour |
| --- | --- |
| Graticule | 30° at z1–3, 10° at z4–5, 5° at z6–7, none at z8+. Lines are clipped to the visible bounds (a world view draws all, a zoomed view draws the few crossing it), hairline `--rule`, with the equator and prime meridian one class stronger. Rebuilt on `zoomend` (and `moveend`, because the visible span changes), throttled 60 ms, beneath the cells. |
| Country names | `countryLabels()` anchors, drawn as `L.divIcon` text (no marker images), 10 px uppercase, cap 20. Only at z≥3 **and** when the country's projected bounding box is ≥900 px²; an anchor outside the viewport, or a box overlapping a city label, is dropped. Countries never displace cities; larger countries win. |
| City labels | `placeLabelsForZoom(zoom)`: rank 0 at z1–2, ≤1 at z3–4, ≤2 at z5–6, ≤3 at z7+. Screen-space greedy collision, most prominent first, hard cap 40 in view. A label that does not fit is dropped; the sidebar remains the full record. |
| Cell rings | Parent and grandparent outlines are looked up from the dataset when an own cell is drawn (`region-cell--own`), and a selected child's published children are outlined after `drawSelection`. Missing rows are skipped: the map never synthesizes a deeper rectangle. Rings are stroke-only, brought behind the cells. Provisional cells keep the hatched ancestor treatment. |
| World LOD | 110m is the first paint for every stage. A `full` stage loads the 1:50m world lazily when the zoom first reaches 5 and swaps it in (`data-detail="50m"`), returning to 110m below 5 without discarding the parsed layer; `compact` never loads it. One dynamic import per stage; `feature()` runs once per geometry, never per zoom. A failed import keeps 110m and retries on the next crossing. |

Label geometry is estimated rather than measured: width is
`ceil(length × fontSize × 0.62 + 8)` (0.68 for uppercase) and height is
`ceil(fontSize × 1.35)`. The estimate is deliberately a little wide, so two
labels that look separate on screen cannot overlap. City and country labels use
`pointer-events: none`, have no tab stop, and live on an `aria-hidden` canvas.

### Compact vs full

| | `compact` (onboarding) | `full` (page, assign/review) |
| --- | --- | --- |
| World | 110m, existing `.join-world` styling | 110m, `.map-world` |
| Graticule | none | yes |
| Country/city labels | none, and the label chunk is never fetched | yes |
| Rings | none | parent, grandparent, selected child's children |

### Performance

The label chunk is separate (`labels-*.js`, **32.96 kB raw / 10.63 kB gzip**)
and the 1:50m world is its own lazy chunk (`countries-50m-*.js`, **756.5 kB raw
/ 233.0 kB gzip**, fetched once above zoom 5). `map-base` grew by **6.15 kB raw
/ 2.70 kB gzip** for the graticule, collision renderer and rings. A zoom step at
1200×800 on this machine measured **0.3–1.3 ms** for labels in steady state
(worst observed 6.8 ms on the first z3 frame that also builds 17 country
labels) and **0.1–0.4 ms** for the graticule, well under the 16 ms frame budget.
The 50m swap is a one-time cost at the crossing: JSON parse 4.8–8.1 ms,
`feature()` 3.3–8.8 ms, `L.geoJSON` path build 22.7–31.4 ms (241 paths), after
which the parsed layer is kept for instant re-entry. Label data is fetched once
and `placeLabelsForZoom` returns precomputed frozen arrays per band; a pan
reprojects the current band and reruns the greedy pass instead of refiltering
the JSON.

For measurement and tests, a completed detail rebuild dispatches a
`map-detail` `CustomEvent` on the map container:

```ts
{ ms: number; graticuleMs: number; zoom: number; places: number;
  countries: number; step: number | null }
```

`step` is the graticule spacing (`30 | 10 | 5 | null`).

`maxZoom` policy: 11 is the rendering ceiling. Zooming in enlarges rectangles;
it does not create detail below `manifest.maxPathLen` (7 today). Raising it
further would only enlarge empty ocean.

Attribution stays `Geometry: Natural Earth (public domain).` in normal builds
and `Sample region data (not the live dataset).` offline, in `#map-source`.
`attributionControl: false` remains. All label data is vendored Natural Earth
(public domain), a same-origin asset, so the CSP needs no new origin.

Non-goals: raster/vector tiles, OSM, 10m coastlines, admin-1 boundaries, a
population choropleth, a gazetteer/search box, cells below the published
prefix, animated page-load flourishes, a map on `#simple-view`.

## 5. Accessibility contract

- `#map-canvas` is `aria-hidden="true"`, `keyboard:false`, `zoomControl:false`,
  `attributionControl:false`, and its `tabindex` is removed by the base map.
  No Leaflet control is focusable.
- `#map-controls` is a real `role="group"` of 44 px buttons outside the canvas:
  Zoom out, World, Zoom in. They are the keyboard equivalent of wheel/pinch.
- Focus order on entry: `#map-title` → `#map-back` → tabs → zoom group →
  coordinate form → cell list → actions. The canvas is skipped.
- Tabs use the existing `region-tabs` arrow-key pattern with roving tabindex.
- `#map-status` is `role="status" aria-live="polite"`, empty at first paint.
  It announces resolution, "Cell a selected…", and failures.
- Every fact on the canvas is text in the sidebar. A cell row's accessible name
  is "Slot 1, cell a, address 0, Free", and its selected state is `aria-pressed`.
- Failure states: Leaflet chunk/init failure hides the canvas and shows
  `#map-unavailable`; the sidebar still resolves the zone through the dataset
  client (no Leaflet). A missing shard draws the nearest published ancestor and
  says detail is unavailable; an invalid shard is a hard error with no partial
  cell. The address is always shown.
- `#simple-view` contains no map node; `copy.test.ts` and the e2e suite assert
  this.

---

## 6. Inline assignment seam (follow-up lane)

Pass 1 renders child rows as buttons and calls `onSelectCell` if supplied. It
does not open the slot editor.

```ts
// ui/src/region/map-page.ts
export interface MapPageDeps {
  /** Called when a child row is chosen. */
  onSelectCell?(slot: number, child: ChildRegion): void;
  /** Optional enriched chain: names and owner ids. */
  readChain?(address: string): Promise<MapChainRow[]>;
  /** Optional navigation from a chain row. */
  onChainOpen?(row: MapChainRow): void;
  /** Optional Back override; the shell already passes one. */
  onBack?(): void;
}
```

```ts
// ui/src/region/map-base.ts
export interface MapStageOptions {
  /** "compact" onboarding, "full" page/dialog. */
  detail?: MapDetail;
  maxZoom?: number;
  countryClassName?: string;
  countryStyle?: L.PathOptions;
  onClick?: (point: MapPoint) => void;
  /** Map click → slot. Supplying both enables click-to-select. */
  hitTestCell?: (point: MapPoint) => number | null;
  onSelectCell?: (slot: number) => void;
}
export interface MapStage {
  addCell(row: RegionRow, className: string): void;
  addLabel(row: RegionRow, text: string, className: string, size?: [number, number]): void;
  drawSelection(row: RegionRow): void;
  fitRows(rows: readonly RegionRow[], options?: FitOptions): void;
  // invalidate, destroy, clear, addPoint, setWorld, setView, zoomIn, zoomOut
}
```

Pass 3 implements both wirings; they share one selection state.

- **Row click and canvas click are identical:** highlight the row, set
  `aria-pressed`, announce `Selected slot N, cell c.` in `#map-status`, and
  reveal `#map-assign-selected`. Neither navigates nor opens the editor.
- **A free selected slot** shows `#map-assign-selected` (`Assign slot N…`).
  **A taken slot** stays selectable for inspection but hides the action and
  shows `#map-cell-warning`: `Slot N is taken, so it cannot take a new child.`
  **A provisional free child** is never canvas-selectable (the map draws the
  ancestor, so a click cannot distinguish the eight) but its row offers the
  action, matching the assign dialog.
- **Handoff:** the action calls `onSelectCell(slot, child)`; `main.ts`'s
  `openSelectedChild` reuses the same `openEditor(slot)` path the assign dialog
  uses after `chooseAssignSlot`. The slot index is the address digit, so no
  second address is stored. Taken or mismatched slots are refused in both the
  page and `main.ts`. Nothing is written until the owner saves.
- **Hit test** (`ui/src/region/hit-test.ts`, pure): longitude-normalised,
  published children only; half-open first pass with one closed-edge retry;
  shared edges resolve to the higher sibling, the outer max edge is included
  once; ambiguous overlaps and malformed input return null. A root zone
  hit-tests its published octants only.
- **Accessible row name** is derived from the visible content (slot, letter,
  address, state) with the population line `aria-hidden`, because Axe's
  `label-content-name-mismatch` requires the visible text to be a contiguous
  part of the name. `#map-assign` remains the guided dialog entry and becomes
  quiet while a direct action is visible.
- Files: `ui/src/region/hit-test.ts`, `ui/src/region/map-page.ts`,
  `ui/src/main.ts`, `ui/index.html` (`#map-assign-selected`), plus unit and
  offline e2e tests.

---

## 7. File map

```
ui/src/view-mode.ts        ViewMode + ?view/?place parsing (unit-tested)
ui/src/region/map-base.ts  Leaflet, countries-110m, cells, graticule, labels, rings
ui/src/region/map-detail.ts  DOM-free zoom bands, label sizing, collision, ancestor paths
ui/src/region/labels.ts    vendored Natural Earth anchors and place LOD (detail lane)
ui/src/region/hit-test.ts  click → published child slot (pure, unit-tested)
ui/src/region/map-page.ts  page controller, sidebar, place tab, fallback, selection
ui/src/region/picker.ts    assign + review dialog only, on the base map
ui/src/region/session.ts   one dataset/manifest source per document
ui/src/region/onboarding-panel.ts  compact embed on the base map
ui/index.html              #map-view, page ids, slim #region-dialog
ui/src/main.ts             mode paint/focus/history, entry points, destroy on leave
ui/src/styles.css          .map-page, full bleed, sticky stage, 22rem sidebar,
                           canvas heights, 44px zoom group, detail labels/rings
ui/src/assets/*.json       countries-110m/50m (world-atlas), country label
                           anchors, populated places (Natural Earth, public domain)
ui/scripts/gen-map-labels.mjs  one-off label extractor (not part of the build)
ui/src/copy.test.ts        Advanced slice ends at #map-view; map copy rules
ui/src/view-mode.test.ts   URL parsing
ui/src/region/map-detail.test.ts  graticule bands, collision, rings
ui/src/region/hit-test.test.ts  published/provisional, edges, antimeridian
ui/src/region/labels.test.ts    anchors, place LOD, country joins
ui/src/region/map-page.test.ts  chain, cell text, state line, selection action
ui/e2e/offline.spec.ts     page, deep link, tabs, selection handoff, fallback,
                           axe, no external
```

Bundle: `index-*.js` grows only by the trigger and dynamic `import()`.
Leaflet + geometry stay in `map-base-*.js` (267.0 kB raw / 86.3 kB gzip after
pass 2, shared by page, dialog and onboarding). Label data is the separate
`labels-*.js` chunk (33.0 kB raw / 10.6 kB gzip) fetched only for `full`.
`map-page-*.js` is ≈14 kB raw / 4.8 kB gzip and contains no Leaflet. There is
one Leaflet instance per visible surface; the page destroys it on leave and
creates it again on return.

## 8. Pass plan

- **Pass 1 (this):** page shell, base map, view mode, dialog slimmed,
  onboarding on the base map, tests, this document.
- **Pass 2 (detail): implemented.** Graticule, country names, populated-place
  labels and density rules, ancestor/selected-child rings, `map-detail.ts` and
  its tests. 50m coastlines remain rejected; no admin-1.
- **Pass 3 (inline): implemented.** Row and canvas selection, `#map-assign-selected`
  → the existing slot editor, `hit-test.ts`, and the accessible row naming. Files:
  `hit-test.ts`, `map-page.ts`, `main.ts`, `index.html`.
- **Pass 4 (world LOD): implemented.** 1:50m world lazy-loaded above zoom 5 on
  `full` stages, 110m retained for first paint/compact, quiet failure with one
  retry, `data-detail` for tests. Files: `assets/countries-50m.json`,
  `map-base.ts`, `map-detail.ts`.

## 9. Verification

```
cd ui
npx tsc --noEmit
npx vitest run
npm run build
npm run test:e2e:offline
```

All four pass. UI 652 tests / 41 files; offline e2e 41. The e2e suite asserts:
page opens from Advanced at the top with Back restoring Advanced's scroll; root
address, badge, chain and eight child rows; deep link `?view=map&place=1` and
Back to Advanced; `place=1` dropped on tab change; the place tab starts at the
world, a real canvas click fills the coordinates and resolves a cell (marker +
table), and the zone tab restores; row and canvas selection reach the slot
editor; the 1:50m world swaps in above zoom 5 (241 paths) and back (177);
the map-chunk failure fallback with the sidebar intact; zero external requests;
Axe clean on `#map-view`; no map inside `#simple-view`.
