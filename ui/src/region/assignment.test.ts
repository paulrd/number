import { describe, expect, it } from "vitest";
import {
  assignmentWarning,
  rankAssignmentChoices,
  type AssignmentPoint,
} from "./assignment";
import { RegionDataset } from "./dataset";
import { buildFixture } from "./fixture";
import { pathLetters } from "./paths";
import { FixtureSource } from "./source";
import type { RegionRow } from "./wire";
import {
  resolveZoneRegion,
  type ChildRegion,
  type SlotOccupancy,
  type ZoneRegion,
} from "./zone-region";

async function open(): Promise<RegionDataset> {
  const fixture = buildFixture();
  const source = new FixtureSource(fixture.manifestState, fixture.shards);
  return RegionDataset.open(source);
}

function freeSlots(): SlotOccupancy[] {
  return Array.from({ length: 8 }, () => "free");
}

function row(
  path: number[],
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
  population: number,
): RegionRow {
  return {
    path,
    letters: pathLetters(path),
    minLon,
    maxLon,
    minLat,
    maxLat,
    population,
  };
}

function child(
  slot: number,
  childRow: RegionRow | null,
  ancestor: RegionRow | null,
): ChildRegion {
  return {
    slot,
    digit: slot,
    letter: "abcdefgh"[slot]!,
    address: `0${slot}`,
    row: childRow,
    ancestor,
    provisional: childRow === null,
    occupied: "free",
  };
}

/** A zone whose slot 0 is provisional and slots 1..7 are published. */
function partlyProvisionalZone(): ZoneRegion {
  const children = Array.from({ length: 8 }, (_, slot) =>
    slot === 0
      ? child(slot, null, null)
      : child(
          slot,
          row([0, slot], slot * 10, (slot + 1) * 10, 0, 10, slot + 1),
          null,
        ),
  );
  return {
    address: "0",
    root: false,
    cell: null,
    ancestor: null,
    provisional: true,
    children,
    freeCount: 8,
  };
}

describe("assignment ranking", () => {
  it("chooses a contained published cell first and marks it best fit", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "0", freeSlots());
    const choices = rankAssignmentChoices(region, { lat: 1, lng: 1 });

    expect(choices).toHaveLength(8);
    expect(choices[0]?.child.slot).toBe(0);
    expect(choices[0]?.free).toBe(true);
    expect(choices[0]?.containsPoint).toBe(true);
    expect(choices[0]?.bestFit).toBe(true);
    expect(choices.filter((choice) => choice.bestFit)).toHaveLength(1);
  });

  it("moves to the next published cell when the ideal slot is taken", async () => {
    const dataset = await open();
    const slots = freeSlots();
    slots[0] = "taken";
    const region = await resolveZoneRegion(dataset, "0", slots);
    const choices = rankAssignmentChoices(region, { lat: 1, lng: 1 });

    expect(choices[0]?.child.slot).toBe(1);
    expect(choices[0]?.free).toBe(true);
    expect(choices[0]?.bestFit).toBe(false);
    expect(choices.find((choice) => choice.child.slot === 0)?.free).toBe(false);
  });

  it("sorts provisional children after published ones", async () => {
    const region = partlyProvisionalZone();
    const choices = rankAssignmentChoices(region, { lat: 5, lng: 15 });

    expect(choices[0]?.child.slot).toBe(1);
    expect(choices[0]?.containsPoint).toBe(true);
    expect(choices[0]?.bestFit).toBe(true);
    expect(choices[choices.length - 1]?.child.slot).toBe(0);
    expect(choices[choices.length - 1]?.child.provisional).toBe(true);
    expect(choices[choices.length - 1]?.containsPoint).toBe(false);
  });

  it("orders occupied slots after free slots, by slot", async () => {
    const dataset = await open();
    const slots = freeSlots();
    slots[0] = "taken";
    slots[3] = "taken";
    const region = await resolveZoneRegion(dataset, "0", slots);
    const choices = rankAssignmentChoices(region, null);

    expect(choices.slice(0, 6).every((choice) => choice.free)).toBe(true);
    expect(choices.slice(6).map((choice) => choice.child.slot)).toEqual([0, 3]);
  });

  it("uses population when no point is given", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "0", freeSlots());
    const choices = rankAssignmentChoices(region, null);

    expect(choices[0]?.child.slot).toBe(7);
    expect(choices.every((choice) => choice.containsPoint)).toBe(false);
    expect(choices.every((choice) => choice.bestFit)).toBe(false);
  });
});

describe("assignment warnings", () => {
  const point: AssignmentPoint = { lat: 1, lng: 1 };

  it("warns when the point is outside the zone", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "0", freeSlots());
    const choice = rankAssignmentChoices(region, { lat: 60, lng: 1 })[0]!;

    expect(assignmentWarning(choice, region, { lat: 60, lng: 1 })).toBe(
      "They are outside your region, so none of your cells contains their location.",
    );
  });

  it("warns when the slot is already taken", async () => {
    const dataset = await open();
    const slots = freeSlots();
    slots[0] = "taken";
    const region = await resolveZoneRegion(dataset, "0", slots);
    const choice = rankAssignmentChoices(region, null).find(
      (candidate) => !candidate.free,
    )!;

    expect(assignmentWarning(choice, region, null)).toBe(
      "That slot is already taken.",
    );
  });

  it("warns when the cell is provisional", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "000", freeSlots());
    const choice = rankAssignmentChoices(region, null)[0]!;

    expect(assignmentWarning(choice, region, null)).toBe(
      "This cell is provisional, so the map cannot tell whether it contains their location.",
    );
  });

  it("warns when a published cell does not contain the point", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "0", freeSlots());
    const choice = rankAssignmentChoices(region, point).find(
      (candidate) => candidate.free && !candidate.containsPoint,
    )!;

    expect(assignmentWarning(choice, region, point)).toBe(
      "This cell does not contain their location. They can still join, but their region will not match where they are.",
    );
  });

  it("is silent for a contained published free cell or no point", async () => {
    const dataset = await open();
    const region = await resolveZoneRegion(dataset, "0", freeSlots());
    const choice = rankAssignmentChoices(region, point)[0]!;

    expect(assignmentWarning(choice, region, point)).toBeNull();
    expect(assignmentWarning(choice, region, null)).toBeNull();
    expect(assignmentWarning(null, region, null)).toBeNull();
  });
});
