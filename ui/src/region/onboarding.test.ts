import { describe, expect, it } from "vitest";
import type { StateV3 } from "../state";
import type { RegionDataset } from "./dataset";
import {
  findTarget,
  parseRootInput,
  parseRootParam,
  resolveZoneAddress,
  validateRoot,
  type MatchResult,
  type ZoneReader,
  type ZoneView,
} from "./onboarding";
import { pathToAddress } from "./paths";
import type { RegionRow } from "./wire";

const ID = "0123456789abcdef".repeat(4);
const ROOT = "a".repeat(64);
const PARENT = "b".repeat(64);
const CHILD = "c".repeat(64);
const OTHER = "d".repeat(64);
const GHOST = "e".repeat(64);
const BUSY = "f".repeat(64);
const POINT = { lat: 0, lng: 0 };

function makeState(
  parent: string | null,
  slots: ReadonlyArray<string | null>,
): StateV3 {
  return {
    v: 6,
    selfName: { seq: 0, name: null, sig: null },
    parent: { seq: parent === null ? 0 : 1, userId: parent, sig: null },
    childNames: { seq: 0, entries: [], sig: null },
    payments: { seq: 0, settled: [], entry: null, sig: null },
    adjustments: { seq: 0, entries: [], sig: null },
    slots: Array.from({ length: 8 }, (_, index) => {
      const contact = slots[index] ?? null;
      return {
        seq: contact === null ? 0 : 1,
        entry:
          contact === null
            ? null
            : { value: 0n, contact, unit: null, note: null },
        sig: null,
      };
    }),
  };
}

function zone(
  ownerId: string,
  parent: string | null,
  slots: ReadonlyArray<string | null>,
): ZoneView {
  return { ownerId, state: makeState(parent, slots) };
}

function reader(entries: ReadonlyArray<[string, ZoneView]>): ZoneReader {
  const zones = new Map(entries);
  return async (ownerId) => zones.get(ownerId) ?? null;
}

function busySlots(): Array<string | null> {
  return Array.from({ length: 8 }, () => BUSY) as Array<string | null>;
}

function fullSlots(slotZero: string): Array<string | null> {
  const slots = busySlots();
  slots[0] = slotZero;
  return slots;
}

function key(path: readonly number[]): string {
  return `/${path.join("/")}`;
}

class FakeDataset {
  private readonly rows = new Map<string, RegionRow>();
  resolved: number[] | null = null;
  resolveThrows = false;
  lookupThrows = false;

  withRow(
    path: number[],
    bounds: [number, number, number, number] = [-180, 180, -90, 90],
    population = 0,
  ): this {
    const [minLon, maxLon, minLat, maxLat] = bounds;
    this.rows.set(key(path), {
      path: [...path],
      letters: pathToAddress([...path]),
      minLon,
      maxLon,
      minLat,
      maxLat,
      population,
    });
    return this;
  }

  asDataset(): RegionDataset {
    return this as unknown as RegionDataset;
  }

  async lookupRow(path: readonly number[]): Promise<RegionRow | null> {
    if (this.lookupThrows) throw new Error("dataset unavailable");
    return this.rows.get(key(path)) ?? null;
  }

  async nearestPublishedAncestor(
    path: readonly number[],
  ): Promise<{ path: number[]; row: RegionRow; provisional: boolean } | null> {
    for (let length = path.length - 1; length >= 1; length -= 1) {
      const found = this.rows.get(key(path.slice(0, length)));
      if (found) {
        return { path: [...found.path], row: found, provisional: true };
      }
    }
    return null;
  }

  async childrenOf(path: readonly number[]) {
    const children = [];
    for (let digit = 0; digit < 8; digit += 1) {
      children.push({
        digit,
        letters: pathToAddress([...path, digit]),
        row: await this.lookupRow([...path, digit]),
      });
    }
    return children;
  }

  async resolve(_lat: number, _lng: number) {
    if (this.resolveThrows) throw new Error("no published cell");
    const path = this.resolved ?? [];
    const row = this.rows.get(key(path)) ?? {
      path: [...path],
      letters: pathToAddress([...path]),
      minLon: -180,
      maxLon: 180,
      minLat: -90,
      maxLat: 90,
      population: 0,
    };
    return { row, children: await this.childrenOf(path) };
  }
}

function expectTarget(
  result: MatchResult,
): Extract<MatchResult, { kind: "target" }> {
  expect(result.kind).toBe("target");
  if (result.kind !== "target") throw new Error("expected a target");
  return result;
}

function expectSaturated(
  result: MatchResult,
): Extract<MatchResult, { kind: "saturated" }> {
  expect(result.kind).toBe("saturated");
  if (result.kind !== "saturated") throw new Error("expected saturation");
  return result;
}

describe("root parsing", () => {
  it("accepts exactly one lowercase-hex root parameter", () => {
    expect(parseRootParam(`?root=${ID}`)).toBe(ID);
    expect(parseRootParam(`root=${ID}`)).toBe(ID);
    expect(parseRootParam(`?root=${ID}&other=1`)).toBe(ID);
    expect(parseRootParam(`?root=${ID}&root=${ID}`)).toBeNull();
    expect(parseRootParam("?other=1")).toBeNull();
    expect(parseRootParam("")).toBeNull();
    expect(parseRootParam(`?root=${ID.toUpperCase()}`)).toBeNull();
    expect(parseRootParam(`?root=${"a".repeat(63)}`)).toBeNull();
    expect(parseRootParam(`?root=${"a".repeat(65)}`)).toBeNull();
    expect(parseRootParam(`?root=${"g".repeat(64)}`)).toBeNull();
  });

  it("accepts a URL, a query or a bare trimmed id", () => {
    expect(parseRootInput(`  ${ID}  `)).toBe(ID);
    expect(parseRootInput(`https://number.test/?root=${ID}`)).toBe(ID);
    expect(parseRootInput(`https://number.test/?root=${ID}#section`)).toBe(ID);
    expect(parseRootInput(`?root=${ID}`)).toBe(ID);
    expect(parseRootInput(`root=${ID}`)).toBe(ID);

    expect(parseRootInput("https://number.test/path")).toBeNull();
    expect(parseRootInput(`?root=${ID}&root=${ID}`)).toBeNull();
    expect(parseRootInput("hello")).toBeNull();
    expect(parseRootInput("")).toBeNull();
  });
});

describe("root validation", () => {
  it("rejects a malformed id", async () => {
    const read = reader([]);
    expect((await validateRoot(read, "A".repeat(64))).ok).toBe(false);
    expect((await validateRoot(read, "z".repeat(64))).ok).toBe(false);
    expect((await validateRoot(read, "a".repeat(63))).ok).toBe(false);
  });

  it("rejects an unreadable zone", async () => {
    const result = await validateRoot(reader([]), ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unreadable");
  });

  it("rejects a mutual parent", async () => {
    const parentSlots = busySlots();
    parentSlots[3] = ROOT;
    const read = reader([
      [ROOT, zone(ROOT, PARENT, Array(8).fill(null))],
      [PARENT, zone(PARENT, null, parentSlots)],
    ]);

    const result = await validateRoot(read, ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("mutual");
  });

  it("accepts a pending parent and a one-sided parent", async () => {
    const pending = await validateRoot(
      reader([[ROOT, zone(ROOT, PARENT, Array(8).fill(null))]]),
      ROOT,
    );
    expect(pending).toEqual({ ok: true });

    const parentSlots = busySlots();
    parentSlots[3] = OTHER;
    const oneSided = await validateRoot(
      reader([
        [ROOT, zone(ROOT, PARENT, Array(8).fill(null))],
        [PARENT, zone(PARENT, null, parentSlots)],
      ]),
      ROOT,
    );
    expect(oneSided).toEqual({ ok: true });
  });
});

describe("find target", () => {
  it("chooses a free root slot even when its next digit is occupied", async () => {
    const dataset = new FakeDataset().withRow([0]).withRow([1]);
    dataset.resolved = [0];
    const slots = busySlots();
    slots[0] = CHILD;
    slots[1] = null;

    const result = expectTarget(
      await findTarget(
        reader([[ROOT, zone(ROOT, null, slots)]]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );

    expect(result.chain).toHaveLength(1);
    expect(result.chain[0]).toMatchObject({
      ownerId: ROOT,
      address: "",
      freeSlots: [1],
      occupied: 7,
    });
    expect(result.wantCell).toBe("0");
    expect(result.assigned).toMatchObject({
      slot: 1,
      address: "1",
      published: true,
    });
  });

  it("descends one level and accumulates the address", async () => {
    const dataset = new FakeDataset().withRow([0, 1]);
    dataset.resolved = [0, 1];
    const rootSlots = fullSlots(CHILD);
    const childSlots = busySlots();
    childSlots[1] = null;

    const result = expectTarget(
      await findTarget(
        reader([
          [ROOT, zone(ROOT, null, rootSlots)],
          [CHILD, zone(CHILD, ROOT, childSlots)],
        ]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );

    expect(result.chain.map((entry) => entry.address)).toEqual(["", "0"]);
    expect(result.wantCell).toBe("01");
    expect(result.assigned).toMatchObject({
      slot: 1,
      address: "01",
      published: true,
    });
  });

  it("uses the first free recommendation when the next digit is taken", async () => {
    const dataset = new FakeDataset()
      .withRow([2], [-1, 1, -1, 1], 100)
      .withRow([5], [10, 12, 10, 12], 100);
    dataset.resolved = [3];
    const slots = busySlots();
    slots[2] = null;
    slots[5] = null;

    const result = expectTarget(
      await findTarget(
        reader([[ROOT, zone(ROOT, null, slots)]]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );

    expect(result.wantCell).toBe("3");
    expect(result.assigned).toMatchObject({
      slot: 2,
      address: "2",
      published: true,
    });
  });

  it("stops on a missing, pending or mismatched child", async () => {
    const dataset = new FakeDataset();
    dataset.resolved = [0];
    const rootSlots = fullSlots(CHILD);
    const root = zone(ROOT, null, rootSlots);
    const read = reader([[ROOT, root]]);

    const missing = expectSaturated(
      await findTarget(read, dataset.asDataset(), ROOT, POINT),
    );
    expect(missing.reason).toBe("broken");

    const pending = expectSaturated(
      await findTarget(
        reader([[ROOT, root], [CHILD, zone(CHILD, null, fullSlots(BUSY))]]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );
    expect(pending.reason).toBe("broken");

    const mismatched = expectSaturated(
      await findTarget(
        reader([[ROOT, root], [CHILD, zone(CHILD, OTHER, fullSlots(BUSY))]]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );
    expect(mismatched.reason).toBe("broken");
  });

  it("past the published digits follows the lowest descendable slot", async () => {
    const dataset = new FakeDataset().withRow([1, 4]);
    dataset.resolveThrows = true;
    const rootSlots = busySlots();
    rootSlots[0] = GHOST;
    rootSlots[1] = CHILD;
    const childSlots = busySlots();
    childSlots[4] = null;

    const result = expectTarget(
      await findTarget(
        reader([
          [ROOT, zone(ROOT, null, rootSlots)],
          [CHILD, zone(CHILD, ROOT, childSlots)],
        ]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );

    expect(result.chain.map((entry) => entry.address)).toEqual(["", "1"]);
    expect(result.wantCell).toBe("");
    expect(result.assigned).toMatchObject({
      slot: 4,
      address: "14",
      published: true,
    });
  });

  it("returns saturated/full when a full chain has no descendable child", async () => {
    const dataset = new FakeDataset();
    const rootSlots = busySlots();

    const result = expectSaturated(
      await findTarget(
        reader([[ROOT, zone(ROOT, null, rootSlots)]]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );

    expect(result.reason).toBe("full");
    expect(result.chain).toHaveLength(1);
  });

  it("bounds the walk at 32 zones", async () => {
    const ids = Array.from({ length: 33 }, (_, index) =>
      index.toString(16).padStart(2, "0").repeat(32),
    );
    const entries: Array<[string, ZoneView]> = [];
    for (let index = 0; index < 32; index += 1) {
      const parent = index === 0 ? null : ids[index - 1]!;
      entries.push([
        ids[index]!,
        zone(ids[index]!, parent, fullSlots(ids[index + 1]!)),
      ]);
    }
    entries.push([ids[32]!, zone(ids[32]!, ids[31]!, Array(8).fill(null))]);

    const result = expectSaturated(
      await findTarget(
        reader(entries),
        new FakeDataset().asDataset(),
        ids[0]!,
        POINT,
      ),
    );

    expect(result.reason).toBe("broken");
    expect(result.chain).toHaveLength(32);
    expect(result.chain[31]!.address).toHaveLength(31);
  });

  it("does not throw when the dataset fails during the preview", async () => {
    const dataset = new FakeDataset();
    dataset.resolveThrows = true;
    dataset.lookupThrows = true;

    const result = expectTarget(
      await findTarget(
        reader([[ROOT, zone(ROOT, null, Array(8).fill(null))]]),
        dataset.asDataset(),
        ROOT,
        POINT,
      ),
    );

    expect(result.wantCell).toBe("");
    expect(result.assigned).toMatchObject({
      slot: 0,
      address: "0",
      published: false,
    });
  });
});

describe("resolve zone address", () => {
  it("returns the empty address for the root itself", async () => {
    expect(await resolveZoneAddress(reader([]), ROOT, ROOT)).toBe("");
  });

  it("returns one slot digit for a direct child", async () => {
    const rootSlots = Array<string | null>(8).fill(null);
    rootSlots[3] = CHILD;
    const read = reader([
      [ROOT, zone(ROOT, null, rootSlots)],
      [CHILD, zone(CHILD, ROOT, Array(8).fill(null))],
    ]);

    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBe("3");
  });

  it("accumulates one digit per level from the root down", async () => {
    const rootSlots = Array<string | null>(8).fill(null);
    rootSlots[2] = PARENT;
    const parentSlots = Array<string | null>(8).fill(null);
    parentSlots[5] = CHILD;
    const read = reader([
      [ROOT, zone(ROOT, null, rootSlots)],
      [PARENT, zone(PARENT, ROOT, parentSlots)],
      [CHILD, zone(CHILD, PARENT, Array(8).fill(null))],
    ]);

    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBe("25");
  });

  it("stops at the linked root even when it carries a pending parent", async () => {
    const rootSlots = Array<string | null>(8).fill(null);
    rootSlots[3] = CHILD;
    const read = reader([
      [ROOT, zone(ROOT, PARENT, rootSlots)],
      [CHILD, zone(CHILD, ROOT, Array(8).fill(null))],
      [PARENT, zone(PARENT, null, Array(8).fill(null))],
    ]);

    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBe("3");
  });

  it("returns null when a parent cannot be read", async () => {
    const read = reader([
      [CHILD, zone(CHILD, PARENT, Array(8).fill(null))],
    ]);
    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBeNull();
  });

  it("returns null when the chain ends at a different root", async () => {
    const otherSlots = Array<string | null>(8).fill(null);
    otherSlots[4] = CHILD;
    const read = reader([
      [CHILD, zone(CHILD, OTHER, Array(8).fill(null))],
      [OTHER, zone(OTHER, null, otherSlots)],
    ]);

    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBeNull();
  });

  it("returns null on a cycle", async () => {
    const childSlots = Array<string | null>(8).fill(null);
    childSlots[4] = PARENT;
    const parentSlots = Array<string | null>(8).fill(null);
    parentSlots[6] = CHILD;
    const read = reader([
      [CHILD, zone(CHILD, PARENT, childSlots)],
      [PARENT, zone(PARENT, CHILD, parentSlots)],
    ]);

    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBeNull();
  });

  it("returns null beyond 32 hops", async () => {
    const ids = Array.from({ length: 35 }, (_, index) =>
      index.toString(16).padStart(2, "0").repeat(32),
    );
    const entries: Array<[string, ZoneView]> = [];
    for (let index = 0; index < 34; index += 1) {
      const parent = index === 0 ? null : ids[index - 1]!;
      const slots = Array<string | null>(8).fill(null);
      slots[0] = ids[index + 1]!;
      entries.push([ids[index]!, zone(ids[index]!, parent, slots)]);
    }
    entries.push([ids[34]!, zone(ids[34]!, ids[33]!, Array(8).fill(null))]);

    expect(await resolveZoneAddress(reader(entries), ids[0]!, ids[34]!)).toBeNull();
  });

  it("returns null for malformed ids", async () => {
    const read = reader([]);
    expect(await resolveZoneAddress(read, ROOT.toUpperCase(), ROOT)).toBeNull();
    expect(await resolveZoneAddress(read, ROOT, "z".repeat(64))).toBeNull();
    expect(await resolveZoneAddress(read, "a".repeat(63), "a".repeat(63))).toBeNull();
    expect(
      await resolveZoneAddress(read, "A".repeat(64), "A".repeat(64)),
    ).toBeNull();
  });

  it("reads every zone in the chain through the reader", async () => {
    const rootSlots = Array<string | null>(8).fill(null);
    rootSlots[2] = PARENT;
    const parentSlots = Array<string | null>(8).fill(null);
    parentSlots[5] = CHILD;
    const zones = new Map<string, ZoneView>([
      [ROOT, zone(ROOT, null, rootSlots)],
      [PARENT, zone(PARENT, ROOT, parentSlots)],
      [CHILD, zone(CHILD, PARENT, Array(8).fill(null))],
    ]);
    const calls: string[] = [];
    const read: ZoneReader = async (ownerId) => {
      calls.push(ownerId);
      return zones.get(ownerId) ?? null;
    };

    expect(await resolveZoneAddress(read, ROOT, CHILD)).toBe("25");
    expect(calls[0]).toBe(CHILD);
    expect(calls).toContain(PARENT);
    expect(calls[calls.length - 1]).toBe(ROOT);
  });
});
