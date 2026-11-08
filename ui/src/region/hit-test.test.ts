import { describe, expect, it } from "vitest";
import { hitTestCell } from "./hit-test";
import type { RegionRow } from "./wire";
import type { ChildRegion, ZoneRegion } from "./zone-region";

const LETTERS = "abcdefgh";

function row(
  path: number[],
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
): RegionRow {
  const letters = path.map((digit) => LETTERS[digit]!).join("");
  return { path, letters, minLon, maxLon, minLat, maxLat, population: 10 };
}

function child(
  slot: number,
  cell: RegionRow | null,
  overrides: Partial<ChildRegion> = {},
): ChildRegion {
  return {
    slot,
    digit: slot,
    letter: LETTERS[slot]!,
    address: String(slot),
    row: cell,
    ancestor: cell,
    provisional: cell === null,
    occupied: "free",
    ...overrides,
  };
}

function region(
  children: ChildRegion[],
  overrides: Partial<ZoneRegion> = {},
): ZoneRegion {
  return {
    address: "",
    root: true,
    cell: null,
    ancestor: null,
    provisional: false,
    children,
    freeCount: children.filter((entry) => entry.occupied === "free").length,
    ...overrides,
  };
}

/** Eight bands tiling longitude 0..180 and latitude 0..45, as in the fixture. */
function bands(): ChildRegion[] {
  return Array.from({ length: 8 }, (_, slot) =>
    child(slot, row([slot], slot * 22.5, (slot + 1) * 22.5, 0, 45)),
  );
}

describe("hitTestCell", () => {
  it("returns the slot whose published cell contains the point", () => {
    const zone = region(bands());
    for (let slot = 0; slot < 8; slot += 1) {
      const lon = slot * 22.5 + 11.25;
      expect(hitTestCell(zone, { lat: 22.5, lng: lon })).toBe(slot);
    }
  });

  it("returns null outside every published cell", () => {
    const zone = region(bands());
    expect(hitTestCell(zone, { lat: 50, lng: 10 })).toBeNull();
    expect(hitTestCell(zone, { lat: 10, lng: -10 })).toBeNull();
    expect(hitTestCell(zone, { lat: -1, lng: 10 })).toBeNull();
  });

  it("never selects a provisional child, even where its ancestor covers the point", () => {
    const zone = region([
      child(0, row([0], 0, 10, 0, 10)),
      child(1, null, {
        provisional: true,
        ancestor: row([], -20, 20, -20, 20),
      }),
    ]);
    // Inside the provisional child's display ancestor but outside every
    // published child.
    expect(hitTestCell(zone, { lat: -5, lng: -5 })).toBeNull();
  });

  it("uses the published octants for a root zone", () => {
    const zone = region(bands(), { address: "", root: true });
    expect(hitTestCell(zone, { lat: 10, lng: 5 })).toBe(0);
    expect(hitTestCell(zone, { lat: 10, lng: 170 })).toBe(7);
  });

  it("returns null for a root zone whose children are all provisional", () => {
    const zone = region(bands().map((entry) => child(entry.slot, null)), {
      address: "",
      root: true,
    });
    expect(hitTestCell(zone, { lat: 10, lng: 10 })).toBeNull();
  });

  it("gives a shared boundary to exactly one sibling", () => {
    const zone = region([
      child(0, row([0], 0, 10, 0, 10)),
      child(1, row([1], 10, 20, 0, 10)),
    ]);
    expect(hitTestCell(zone, { lat: 5, lng: 10 })).toBe(1);
  });

  it("includes the outer max edge once", () => {
    const zone = region([child(0, row([0], 0, 10, 0, 10))]);
    expect(hitTestCell(zone, { lat: 10, lng: 10 })).toBe(0);
  });

  it("wraps world-copy longitudes before testing", () => {
    const zone = region([child(0, row([0], 0, 22.5, 0, 45))]);
    expect(hitTestCell(zone, { lat: 10, lng: 370 })).toBe(0);
    expect(hitTestCell(zone, { lat: 10, lng: -350 })).toBe(0);
    // 190° wraps to -170°, outside [0, 22.5).
    expect(hitTestCell(zone, { lat: 10, lng: 190 })).toBeNull();
  });

  it("handles cells at the antimeridian seam", () => {
    const zone = region([
      child(0, row([0], -180, -170, 0, 10)),
      child(1, row([1], 170, 180, 0, 10)),
    ]);
    expect(hitTestCell(zone, { lat: 5, lng: -175 })).toBe(0);
    expect(hitTestCell(zone, { lat: 5, lng: 175 })).toBe(1);
    // A world copy of +179 and -179 resolves to the same seam cell.
    expect(hitTestCell(zone, { lat: 5, lng: -181 })).toBe(1);
    expect(hitTestCell(zone, { lat: 5, lng: 181 })).toBe(0);
  });

  it("returns null when published rows overlap and both match", () => {
    const zone = region([
      child(0, row([0], 0, 20, 0, 20)),
      child(1, row([1], 5, 15, 5, 15)),
    ]);
    expect(hitTestCell(zone, { lat: 10, lng: 10 })).toBeNull();
  });

  it("returns null for invalid input", () => {
    const zone = region(bands());
    expect(hitTestCell(zone, { lat: Number.NaN, lng: 10 })).toBeNull();
    expect(hitTestCell(zone, { lat: 10, lng: Number.POSITIVE_INFINITY })).toBeNull();
    expect(hitTestCell(zone, { lat: 91, lng: 10 })).toBeNull();
    expect(hitTestCell(zone, { lat: -91, lng: 10 })).toBeNull();
    expect(
      hitTestCell(null as unknown as ZoneRegion, { lat: 10, lng: 10 }),
    ).toBeNull();
    expect(
      hitTestCell(zone, null as unknown as { lat: number; lng: number }),
    ).toBeNull();
    expect(
      hitTestCell({ ...zone, children: null as unknown as ChildRegion[] }, {
        lat: 10,
        lng: 10,
      }),
    ).toBeNull();
  });
});
