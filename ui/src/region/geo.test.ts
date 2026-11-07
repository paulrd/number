import { describe, expect, it } from "vitest";
import { contains, normalizePoint } from "./geo";

describe("region geometry", () => {
  it("clamps latitude and wraps longitude", () => {
    expect(normalizePoint(100, 190)).toEqual({ lat: 90, lng: -170 });
    expect(normalizePoint(-100, -190)).toEqual({ lat: -90, lng: 170 });
    expect(normalizePoint(0, 180)).toEqual({ lat: 0, lng: -180 });
    expect(normalizePoint(45, 0)).toEqual({ lat: 45, lng: 0 });
  });

  it("uses half-open bounds except for the highest child", () => {
    const bounds = { minLon: 0, maxLon: 10, minLat: 0, maxLat: 10 };
    expect(contains(bounds, { lat: 0, lng: 0 }, false)).toBe(true);
    expect(contains(bounds, { lat: 10, lng: 5 }, false)).toBe(false);
    expect(contains(bounds, { lat: 10, lng: 5 }, true)).toBe(true);
    expect(contains(bounds, { lat: 5, lng: 10 }, false)).toBe(false);
    expect(contains(bounds, { lat: 5, lng: 10 }, true)).toBe(true);
    expect(contains(bounds, { lat: 11, lng: 5 }, true)).toBe(false);
  });
});
