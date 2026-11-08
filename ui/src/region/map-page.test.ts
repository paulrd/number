import { describe, expect, it } from "vitest";
import {
  cellStateText,
  childMetaText,
  deriveChain,
  selectionAction,
  selectionStatusText,
  stateLine,
} from "./map-page";
import type { ChildRegion, ZoneRegion } from "./zone-region";

const row = {
  path: [0, 1],
  letters: "ab",
  minLon: 0,
  maxLon: 90,
  minLat: 0,
  maxLat: 45,
  population: 1240,
};

function child(overrides: Partial<ChildRegion> = {}): ChildRegion {
  return {
    slot: 0,
    digit: 0,
    letter: "a",
    address: "0",
    row,
    ancestor: row,
    provisional: false,
    occupied: "free",
    ...overrides,
  };
}

describe("deriveChain", () => {
  it("shows the root alone for a root address", () => {
    expect(deriveChain("")).toEqual([
      { address: "", label: "root", current: true },
    ]);
  });

  it("walks every address prefix and marks the last row", () => {
    const rows = deriveChain("031");
    expect(rows.map((row) => row.label)).toEqual(["root", "0", "03", "031"]);
    expect(rows.map((row) => row.current)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(rows.map((row) => row.address)).toEqual(["", "0", "03", "031"]);
  });
});

describe("cellStateText", () => {
  it("uses the same three words as the slot list", () => {
    expect(cellStateText("free")).toBe("Free");
    expect(cellStateText("taken")).toBe("Taken");
    expect(cellStateText("unconfirmed")).toBe("Pending");
  });
});

describe("childMetaText", () => {
  it("names the published state and population", () => {
    expect(childMetaText(child())).toBe("Published · population 1,240");
  });

  it("names the containing cell for a provisional child", () => {
    expect(
      childMetaText(
        child({
          row: null,
          provisional: true,
          ancestor: { ...row, path: [0], letters: "a" },
        }),
      ),
    ).toBe("Provisional · inside 0");
  });

  it("omits population when the dataset has no row", () => {
    expect(
      childMetaText(child({ row: null, ancestor: null, provisional: true })),
    ).toBe("Provisional");
  });
});

describe("selectionStatusText", () => {
  it("names the slot by one-based number and the cell by letter", () => {
    expect(selectionStatusText(child({ slot: 2, letter: "c" }))).toBe(
      "Selected slot 3, cell c.",
    );
  });
});

describe("selectionAction", () => {
  it("offers the assign action for a free child", () => {
    expect(selectionAction(child({ slot: 0 }))).toEqual({
      label: "Assign slot 1…",
    });
  });

  it("offers nothing for a taken child or no selection", () => {
    expect(selectionAction(child({ occupied: "taken" }))).toBeNull();
    expect(selectionAction(child({ occupied: "unconfirmed" }))).toBeNull();
    expect(selectionAction(null)).toBeNull();
  });
});

describe("stateLine", () => {
  const base: ZoneRegion = {
    address: "01",
    root: false,
    cell: row,
    ancestor: row,
    provisional: false,
    children: [],
    freeCount: 8,
  };

  it("describes the world for a root", () => {
    expect(stateLine({ ...base, root: true, cell: null, ancestor: null })).toBe(
      "A root zone is the whole world. It has no cell of its own.",
    );
  });

  it("reports depth and population for a published cell", () => {
    expect(stateLine(base)).toBe("Depth 2 · population 1,240");
  });

  it("says detail ends at the nearest mapped ancestor when provisional", () => {
    expect(
      stateLine({
        ...base,
        cell: null,
        provisional: true,
        ancestor: { ...row, path: [0], letters: "a" },
      }),
    ).toBe(
      "Provisional — shown inside a (0). The map does not cover this area yet.",
    );
  });
});
