import { describe, expect, it } from "vitest";
import { RegionDataset } from "./dataset";
import { buildFixture } from "./fixture";
import { FixtureSource } from "./source";
import {
  resolveZoneRegion,
  type SlotOccupancy,
} from "./zone-region";

const LETTERS = "abcdefgh";

async function open(): Promise<RegionDataset> {
  const fixture = buildFixture();
  const source = new FixtureSource(fixture.manifestState, fixture.shards);
  return RegionDataset.open(source);
}

function freeSlots(): SlotOccupancy[] {
  return Array.from({ length: 8 }, () => "free");
}

describe("zone region", () => {
  it("treats the root as the world with eight depth-1 children", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "", freeSlots());

    expect(region.root).toBe(true);
    expect(region.address).toBe("");
    expect(region.cell).toBeNull();
    expect(region.ancestor).toBeNull();
    expect(region.provisional).toBe(false);
    expect(region.freeCount).toBe(8);
    expect(region.children.map((child) => child.slot)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(region.children.map((child) => child.letter)).toEqual(
      [...LETTERS],
    );
    expect(region.children.map((child) => child.address)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    for (const child of region.children) {
      expect(child.row?.letters).toBe(child.letter);
      expect(child.ancestor).toBe(child.row);
      expect(child.provisional).toBe(false);
    }
  });

  it("uses the zone's own published cell", async () => {
    const dataset = await open();
    const slots = freeSlots();
    slots[1] = "taken";
    slots[4] = "unconfirmed";
    const region = await resolveZoneRegion(dataset, "0", slots);

    expect(region.root).toBe(false);
    expect(region.cell?.letters).toBe("a");
    expect(region.ancestor?.letters).toBe("a");
    expect(region.provisional).toBe(false);
    expect(region.freeCount).toBe(6);
    expect(region.children.map((child) => child.address)).toEqual([
      "00",
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
    ]);
    expect(region.children.every((child) => child.row !== null)).toBe(true);
    expect(region.children[1]?.occupied).toBe("taken");
    expect(region.children[4]?.occupied).toBe("unconfirmed");
  });

  it("falls back to the nearest published ancestor when provisional", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "000", freeSlots());

    expect(region.root).toBe(false);
    expect(region.cell).toBeNull();
    expect(region.ancestor?.letters).toBe("aa");
    expect(region.provisional).toBe(true);
    expect(region.freeCount).toBe(8);
    expect(region.children.map((child) => child.address)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ]);
    for (const child of region.children) {
      expect(child.row).toBeNull();
      expect(child.ancestor).toBe(region.ancestor);
      expect(child.provisional).toBe(true);
    }
  });

  it("counts missing slot entries as free", async () => {
    const dataset = await open();
    const slots = freeSlots();
    slots[0] = "taken";
    slots[2] = "unconfirmed";
    slots[4] = undefined as unknown as SlotOccupancy;
    const region = await resolveZoneRegion(dataset, "0", slots);

    expect(region.freeCount).toBe(6);
    expect(region.children[4]?.occupied).toBe("free");
  });

  it("requires exactly eight slot entries", async () => {
    const dataset = await open();
    await expect(
      resolveZoneRegion(dataset, "0", freeSlots().slice(0, 7)),
    ).rejects.toThrow(/exactly 8/);
  });

  it("propagates address parse errors", async () => {
    const dataset = await open();
    await expect(resolveZoneRegion(dataset, "8", freeSlots())).rejects.toThrow(
      /non 0-7/,
    );
    await expect(resolveZoneRegion(dataset, "a", freeSlots())).rejects.toThrow(
      /non 0-7/,
    );
  });
});
