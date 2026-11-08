import { describe, expect, it } from "vitest";
import {
  ancestorPaths,
  boxesOverlap,
  countryLabelVisible,
  DETAIL_WORLD_MIN_ZOOM,
  detailedWorldForZoom,
  graticuleForZoom,
  graticuleStepForZoom,
  graticuleValues,
  labelHeight,
  labelWidth,
  selectLabels,
  type LabelCandidate,
} from "./map-detail";

function candidate(
  overrides: Partial<LabelCandidate> & Pick<LabelCandidate, "id">,
): LabelCandidate {
  return {
    text: overrides.id,
    rank: 0,
    x: 0,
    y: 0,
    width: 40,
    height: 16,
    ...overrides,
  };
}

describe("graticule zoom bands", () => {
  it("uses 30° at world zoom, 10° and 5° closer in, none at detail zoom", () => {
    expect(graticuleStepForZoom(1)).toBe(30);
    expect(graticuleStepForZoom(3)).toBe(30);
    expect(graticuleStepForZoom(4)).toBe(10);
    expect(graticuleStepForZoom(5)).toBe(10);
    expect(graticuleStepForZoom(6)).toBe(5);
    expect(graticuleStepForZoom(7)).toBe(5);
    expect(graticuleStepForZoom(8)).toBeNull();
    expect(graticuleStepForZoom(11)).toBeNull();
  });

  it("treats a non-finite zoom as the world band", () => {
    expect(graticuleStepForZoom(Number.NaN)).toBe(30);
  });

  it("builds parallels without the poles and meridians through 0", () => {
    const thirty = graticuleValues(30);
    expect(thirty.parallels).toEqual([-60, -30, 0, 30, 60]);
    expect(thirty.meridians).toContain(0);
    expect(thirty.meridians).toContain(-180);
    expect(thirty.meridians).not.toContain(180);

    const ten = graticuleValues(10);
    expect(ten.parallels).toContain(0);
    expect(ten.parallels.length).toBeGreaterThan(thirty.parallels.length);
  });

  it("returns a complete spec or null, never a partial one", () => {
    expect(graticuleForZoom(8)).toBeNull();
    const spec = graticuleForZoom(4);
    expect(spec).not.toBeNull();
    expect(spec?.step).toBe(10);
    expect(spec?.parallels).toContain(0);
    expect(spec?.meridians).toContain(0);
  });
});

describe("detailed world threshold", () => {
  it("swaps at zoom 5 exactly", () => {
    expect(DETAIL_WORLD_MIN_ZOOM).toBe(5);
    expect(detailedWorldForZoom(4)).toBe(false);
    expect(detailedWorldForZoom(5)).toBe(true);
    expect(detailedWorldForZoom(6)).toBe(true);
  });

  it("treats non-finite and negative zooms as the 110m world", () => {
    expect(detailedWorldForZoom(Number.NaN)).toBe(false);
    expect(detailedWorldForZoom(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(detailedWorldForZoom(-1)).toBe(false);
  });
});

describe("label sizing", () => {
  it("is deterministic and monotonic in text length", () => {
    expect(labelWidth("Paris", 11)).toBe(labelWidth("Paris", 11));
    expect(labelWidth("Paris", 11)).toBeLessThan(
      labelWidth("Paris and its region", 11),
    );
    expect(labelHeight(11)).toBeGreaterThan(11);
  });

  it("reserves more width for uppercase country names", () => {
    expect(labelWidth("France", 10, true)).toBeGreaterThan(
      labelWidth("France", 10),
    );
  });
});

describe("country label gate", () => {
  it("is hidden at world zoom even for a large shape", () => {
    expect(countryLabelVisible(2, 1_000_000)).toBe(false);
  });

  it("requires both a minimum zoom and a real screen area", () => {
    expect(countryLabelVisible(4, 100)).toBe(false);
    expect(countryLabelVisible(4, 900)).toBe(true);
    expect(countryLabelVisible(Number.NaN, 5_000)).toBe(false);
  });
});

describe("selectLabels", () => {
  const viewport = { width: 800, height: 600 };

  it("orders by rank, then text, then id", () => {
    const labels = selectLabels(
      [
        candidate({ id: "b", text: "b", rank: 1, y: 0 }),
        candidate({ id: "a", text: "a", rank: 1, y: 100 }),
        candidate({ id: "top", text: "top", rank: 0, y: 200 }),
      ],
      viewport,
    );
    expect(labels.map((label) => label.id)).toEqual(["top", "a", "b"]);
  });

  it("drops overlaps and never mutates the input", () => {
    const first = candidate({ id: "first", x: 10, y: 10 });
    const overlap = candidate({ id: "overlap", x: 20, y: 20 });
    const free = candidate({ id: "free", x: 300, y: 300 });
    const input = [overlap, first, free];
    const labels = selectLabels(input, viewport);
    expect(labels.map((label) => label.id)).toEqual(["first", "free"]);
    expect(input[0]).toBe(overlap);
  });

  it("respects the cap and pre-occupied boxes", () => {
    const input = Array.from({ length: 10 }, (_, index) =>
      candidate({ id: `l${index}`, x: index * 60, y: 100 }),
    );
    expect(selectLabels(input, viewport, { cap: 3 })).toHaveLength(3);

    const occupied = [{ x: 0, y: 90, width: 100, height: 40 }];
    const labels = selectLabels(input, viewport, { occupied });
    expect(labels.some((label) => label.id === "l0")).toBe(false);
    expect(labels.some((label) => label.id === "l2")).toBe(true);
  });

  it("suppresses labels wholly outside the viewport", () => {
    const labels = selectLabels(
      [
        candidate({ id: "left", x: -100, y: 10 }),
        candidate({ id: "below", x: 10, y: 700 }),
        candidate({ id: "visible", x: 700, y: 500 }),
      ],
      viewport,
    );
    expect(labels.map((label) => label.id)).toEqual(["visible"]);
  });

  it("returns nothing for no candidates", () => {
    expect(selectLabels([], viewport)).toEqual([]);
  });
});

describe("boxesOverlap", () => {
  it("treats the padding as a required gap", () => {
    const a = { x: 0, y: 0, width: 20, height: 10 };
    const b = { x: 21, y: 0, width: 20, height: 10 };
    expect(boxesOverlap(a, b, 0)).toBe(false);
    expect(boxesOverlap(a, b, 4)).toBe(true);
  });
});

describe("ancestorPaths", () => {
  it("returns the parent and grandparent, nearest first", () => {
    expect(ancestorPaths([0, 2, 1])).toEqual([
      [0, 2],
      [0],
    ]);
  });

  it("never returns the own path or the world root", () => {
    const own = [3, 1, 4];
    const paths = ancestorPaths(own);
    expect(paths).not.toContainEqual(own);
    expect(paths.every((path) => path.length > 0)).toBe(true);
  });

  it("handles shallow and empty paths", () => {
    expect(ancestorPaths([3])).toEqual([]);
    expect(ancestorPaths([])).toEqual([]);
  });
});
