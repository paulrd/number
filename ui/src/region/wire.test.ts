import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { parsePath } from "./paths";
import {
  decodeManifestState,
  findEntry,
  parseManifest,
  parseShard,
} from "./wire";

interface Expected {
  start: string;
  rows: number;
  bytes: number;
  hash: string;
  total_rows: number;
  row_bytes: number;
  shard_bytes: number;
  shard_count: number;
  max_path_len: number;
  blob_code_hash: string;
}

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../fixtures/regions/${name}`, import.meta.url)),
  );

const expected = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/regions/expected.json", import.meta.url),
    "utf8",
  ),
) as Expected;

const manifestBytes = fixture("manifest.bin");
const shardBytes = fixture("shard.bin");

describe("region manifest payload", () => {
  it("parses the committed golden and recomputes the dataset id", () => {
    const manifest = parseManifest(manifestBytes);
    expect(manifest.rowFormat).toBe(2);
    expect(manifest.codeHashes).toHaveLength(1);
    expect(bs58.encode(manifest.codeHashes[0]!)).toBe(expected.blob_code_hash);
    expect(manifest.totalRows).toBe(expected.total_rows);
    expect(manifest.maxPathLen).toBe(expected.max_path_len);
    expect(manifest.entries).toHaveLength(expected.shard_count);
    expect(manifest.entries[0]!.letters).toBe(expected.start);
    expect(manifest.entries[0]!.rows).toBe(expected.rows);
    expect(manifest.entries[0]!.bytes).toBe(expected.bytes);
    expect(bs58.encode(manifest.entries[0]!.hash)).toBe(expected.hash);
    expect(manifest.entries.map((entry) => entry.letters)).toEqual([
      "a",
      "c",
      "e",
      "g",
    ]);
  });

  it("rejects a tampered payload", () => {
    const tampered = manifestBytes.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() => parseManifest(tampered)).toThrow(/dataset id/);

    const truncated = manifestBytes.slice(0, manifestBytes.length - 1);
    expect(() => parseManifest(truncated)).toThrow();
  });
});

describe("region manifest state envelope", () => {
  it("splits seq, payload and signature", () => {
    const payload = manifestBytes;
    const state = new Uint8Array(12 + payload.length + 64);
    const view = new DataView(state.buffer);
    view.setBigUint64(0, 1n, true);
    view.setUint32(8, payload.length, true);
    state.set(payload, 12);

    const decoded = decodeManifestState(state);
    expect(decoded.seq).toBe(1);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
    expect(decoded.signature).toHaveLength(64);
  });

  it("rejects a declared length that does not match", () => {
    const payload = manifestBytes;
    const state = new Uint8Array(12 + payload.length + 64);
    const view = new DataView(state.buffer);
    view.setBigUint64(0, 1n, true);
    view.setUint32(8, payload.length + 1, true);
    state.set(payload, 12);
    expect(() => decodeManifestState(state)).toThrow(/envelope declares/);
  });
});

describe("region shard", () => {
  const manifest = parseManifest(manifestBytes);
  const entry = manifest.entries[0]!;
  const nextStart = manifest.entries[1]?.start ?? null;

  it("verifies the hash and parses the golden rows", () => {
    const rows = parseShard(shardBytes, entry, manifest.maxPathLen, nextStart);
    expect(rows).toHaveLength(expected.rows);
    expect(rows[0]!.letters).toBe("a");
    expect(rows[0]!.minLon).toBe(0);
    expect(rows[0]!.maxLon).toBe(0.25);
    expect(rows[0]!.minLat).toBe(0);
    expect(rows[0]!.maxLat).toBe(0.25);
    expect(rows[0]!.population).toBe(0);
    expect(rows[rows.length - 1]!.letters).toBe("bh");
    expect(rows[9]!.letters).toBe("b");
    expect(rows[9]!.population).toBe(9);
  });

  it("rejects a modified shard before parsing it", () => {
    const tampered = shardBytes.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() =>
      parseShard(tampered, entry, manifest.maxPathLen, nextStart),
    ).toThrow(/content hash/);
  });

  it("rejects a truncated shard", () => {
    const truncated = shardBytes.slice(0, shardBytes.length - 1);
    expect(() =>
      parseShard(truncated, entry, manifest.maxPathLen, nextStart),
    ).toThrow(/manifest says/);
  });

  it("finds the shard for a path, including the last unbounded one", () => {
    expect(findEntry(manifest, parsePath("a"))?.letters).toBe("a");
    expect(findEntry(manifest, parsePath("b"))?.letters).toBe("a");
    expect(findEntry(manifest, parsePath("c"))?.letters).toBe("c");
    expect(findEntry(manifest, parsePath("h"))?.letters).toBe("g");
  });
});
