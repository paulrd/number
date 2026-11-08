/**
 * The three paint states of one document.
 *
 * Simple and Advanced are peers; Map is Advanced's full-screen sub-page. The
 * header still exposes only the Simple/Advanced toggle, so a map is never a
 * top-level destination and `#simple-view` stays map-free.
 */

export type ViewMode = "simple" | "advanced" | "map";

/** Read `?view=`; anything but `advanced` or `map` is the default surface. */
export function viewModeFromSearch(search: string): ViewMode {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const value = params.get("view");
  if (value === "advanced" || value === "map") return value;
  return "simple";
}

/** The map page's initial tab: `?place=1` opens "Find a place". */
export function mapTabFromSearch(
  search: string,
): "zone" | "place" {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  return params.get("place") === "1" ? "place" : "zone";
}
