import { describe, expect, it } from "vitest";
import {
  ManifestInvalid,
  NoPublishedCell,
  RegionDataset,
  ShardInvalid,
  ShardMissing,
} from "./dataset";
import { buildFixture } from "./fixture";
import { FixtureSource } from "./source";

async function open(): Promise<{
  dataset: RegionDataset;
  source: FixtureSource;
}> {
  const fixture = buildFixture();
  const source = new FixtureSource(fixture.manifestState, fixture.shards);
  return { dataset: await RegionDataset.open(source), source };
}

describe("region dataset", () => {
  it("opens the manifest and exposes its facts", async () => {
    const { dataset, source } = await open();
    expect(dataset.manifest.totalRows).toBe(72);
    expect(dataset.manifest.maxPathLen).toBe(2);
    expect(dataset.manifest.entries).toHaveLength(1);
    expect(source.getShardCalls).toBe(0);
  });

  it("looks up rows and refuses depths beyond the stage", async () => {
    const { dataset, source } = await open();
    expect((await dataset.lookupRow([0]))?.letters).toBe("a");
    expect((await dataset.lookupRow([0, 0]))?.letters).toBe("aa");
    expect((await dataset.lookupRow([7, 7]))?.letters).toBe("hh");
    expect(await dataset.lookupRow([0, 0, 0])).toBeNull();
    expect(await dataset.lookupRow([])).toBeNull();
    expect(source.getShardCalls).toBe(1);
    expect(await dataset.lookupRow([0, 0, 0])).toBeNull();
    expect(source.getShardCalls).toBe(1);
  });

  it("returns all eight child cells", async () => {
    const { dataset } = await open();
    const children = await dataset.childrenOf([0]);
    expect(children.map((child) => child.letters)).toEqual([
      "aa",
      "ab",
      "ac",
      "ad",
      "ae",
      "af",
      "ag",
      "ah",
    ]);
    expect(children.every((child) => child.row !== null)).toBe(true);
  });

  it("resolves a point to the deepest published cell", async () => {
    const { dataset } = await open();
    expect((await dataset.resolve(1, 1)).row.letters).toBe("aa");
    expect((await dataset.resolve(30, 30)).row.letters).toBe("bf");
    expect(
      (await dataset.resolve(1, 1)).children.every((child) => child.row === null),
    ).toBe(true);
  });

  it("assigns boundary points by the half-open rule", async () => {
    const { dataset } = await open();
    // 22.5 latitude belongs to the second row of children, not the first.
    expect((await dataset.resolve(22.5, 0)).row.letters).toBe("ae");
    // 22.5 longitude belongs to band b, not band a.
    expect((await dataset.resolve(1, 22.5)).row.letters).toBe("ba");
  });

  it("rejects a point outside every published cell", async () => {
    const { dataset } = await open();
    await expect(dataset.resolve(60, 1)).rejects.toBeInstanceOf(
      NoPublishedCell,
    );
  });

  it("caches the shard across lookups and children", async () => {
    const { dataset, source } = await open();
    await dataset.resolve(1, 1);
    await dataset.resolve(30, 30);
    await dataset.childrenOf([3]);
    expect(source.getShardCalls).toBe(1);
  });

  it("reports a missing shard separately from an invalid one", async () => {
    const fixture = buildFixture();
    const missing = await RegionDataset.open(
      new FixtureSource(fixture.manifestState, new Map()),
    );
    await expect(missing.lookupRow([0, 0])).rejects.toBeInstanceOf(
      ShardMissing,
    );

    const corrupt = new Map(fixture.shards);
    const [key, bytes] = [...corrupt.entries()][0]!;
    const copy = bytes.slice();
    copy[copy.length - 1] ^= 1;
    corrupt.set(key, copy);
    const invalid = await RegionDataset.open(
      new FixtureSource(fixture.manifestState, corrupt),
    );
    await expect(invalid.lookupRow([0, 0])).rejects.toBeInstanceOf(
      ShardInvalid,
    );
  });

  it("rejects a manifest that fails its dataset-id check", async () => {
    const fixture = buildFixture();
    const state = fixture.manifestState.slice();
    // The last payload byte is the entry hash (the final 64 bytes are the
    // signature, which the client does not verify).
    state[state.length - 65] ^= 1;
    await expect(
      RegionDataset.open(new FixtureSource(state, fixture.shards)),
    ).rejects.toBeInstanceOf(ManifestInvalid);
  });

  it("returns the exact row from nearestPublishedAncestor when published", async () => {
    const { dataset } = await open();
    const found = await dataset.nearestPublishedAncestor([0, 0]);
    expect(found?.provisional).toBe(false);
    expect(found?.path).toEqual([0, 0]);
    expect(found?.row.letters).toBe("aa");
  });

  it("returns the nearest published prefix for a deeper or absent path", async () => {
    const { dataset } = await open();
    const deeper = await dataset.nearestPublishedAncestor([0, 0, 0, 0]);
    expect(deeper?.provisional).toBe(true);
    expect(deeper?.path).toEqual([0, 0]);
    expect(deeper?.row.letters).toBe("aa");

    const absent = await dataset.nearestPublishedAncestor([5, 5, 5]);
    expect(absent?.provisional).toBe(true);
    expect(absent?.path).toEqual([5, 5]);
    expect(absent?.row.letters).toBe("ff");
  });

  it("returns null from nearestPublishedAncestor for the root", async () => {
    const { dataset } = await open();
    expect(await dataset.nearestPublishedAncestor([])).toBeNull();
  });
});
