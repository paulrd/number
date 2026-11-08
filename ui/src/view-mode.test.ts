import { describe, expect, it } from "vitest";
import { mapTabFromSearch, viewModeFromSearch } from "./view-mode";

describe("viewModeFromSearch", () => {
  it("defaults to the simple surface", () => {
    expect(viewModeFromSearch("")).toBe("simple");
    expect(viewModeFromSearch("?")).toBe("simple");
    expect(viewModeFromSearch("?view=other")).toBe("simple");
  });

  it("reads advanced and map", () => {
    expect(viewModeFromSearch("?view=advanced")).toBe("advanced");
    expect(viewModeFromSearch("?view=map")).toBe("map");
    expect(viewModeFromSearch("?view=map&place=1")).toBe("map");
  });

  it("accepts a bare query string", () => {
    expect(viewModeFromSearch("view=map")).toBe("map");
  });
});

describe("mapTabFromSearch", () => {
  it("opens the zone tab by default", () => {
    expect(mapTabFromSearch("")).toBe("zone");
    expect(mapTabFromSearch("?view=map")).toBe("zone");
  });

  it("opens the place tab for place=1 only", () => {
    expect(mapTabFromSearch("?view=map&place=1")).toBe("place");
    expect(mapTabFromSearch("?place=0")).toBe("zone");
  });
});
