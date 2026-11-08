# Vendored map geometry

`countries-110m.json` is the `world-atlas@2` `countries-110m` TopoJSON file,
derived from Natural Earth 1:110m. Natural Earth data is public domain.

- Source: <https://github.com/topojson/world-atlas> (`countries-110m.json`)
- Copied unmodified on 2026-11-07 so the build never downloads geometry at
  runtime and the gateway's CSP never needs an external origin.
- Attribution: "Natural Earth" (shown in the picker footer).

## Label assets

`country-labels-110m.json` and `places-50m-labels.json` are generated from
Natural Earth (public domain) by `ui/scripts/gen-map-labels.mjs`. That script
is a one-off developer tool, not part of the build; the JSON is vendored so
the app never downloads labels at runtime.

- Country anchors: Natural Earth 1:110m admin-0 countries, `LABEL_X`/`LABEL_Y`,
  keyed by ISO 3166-1 numeric (`ISO_N3`, with `ISO_N3_EH` as fallback for
  France and Norway where `ISO_N3` is `-99`). Only ids present in the vendored
  topology are emitted, so all 174 numeric-id countries have an anchor. The
  three vendored features without a numeric id (N. Cyprus, Somaliland, Kosovo)
  have no anchor and are skipped by the loader.
- Populated places: Natural Earth 5.1 `ne_50m_populated_places_simple`,
  filtered to `scalerank <= 3`. `rank` is Natural Earth's `SCALERANK`
  (0 = most prominent). Duplicate place names are collapsed to the most
  prominent row.
- Generator sources (download at dev time only):
  <https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson>
  and
  <https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson>.
- `countries-110m.json` is Natural Earth 4.1.0 (`world-atlas@2`), while the
  anchor table comes from the current Natural Earth 1:110m admin-0 release, so
  a label point can sit a few km off the 4.1.0 outline.

Attribution stays: "Geometry: Natural Earth (public domain)."
