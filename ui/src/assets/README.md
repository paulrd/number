# Vendored map geometry

`countries-110m.json` is the `world-atlas@2` `countries-110m` TopoJSON file,
derived from Natural Earth 1:110m. Natural Earth data is public domain.

- Source: <https://github.com/topojson/world-atlas> (`countries-110m.json`)
- Copied unmodified on 2026-11-07 so the build never downloads geometry at
  runtime and the gateway's CSP never needs an external origin.
- Attribution: "Natural Earth" (shown in the picker footer).

`countries-50m.json` is the `world-atlas@2.0.2` `countries-50m` TopoJSON file,
derived from Natural Earth 4.1.0 (1:50m). It is loaded lazily, and only by
`detail: "full"` maps above zoom 5; `compact` maps and the initial bundle keep
using 110m.

- Source: the `world-atlas@2.0.2` npm tarball
  (`https://registry.npmjs.org/world-atlas/-/world-atlas-2.0.2.tgz`), member
  `package/countries-50m.json`, copied unmodified on 2026-11-08.
- Size: 756,420 bytes. SHA-256:
  `04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394`.
- Contents: 241 country features plus 1 `land` feature (TopoJSON).
- Licensing: Natural Earth data is public domain. The `world-atlas` package
  itself is packaged under ISC, matching the 110m file; the data remains
  public-domain Natural Earth.
- Same-origin, same CSP: the build emits it as a local lazy chunk, so no new
  origin is needed.

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
