/**
 * Region dataset client: manifest once, shards on demand, verified before use.
 *
 * The manifest is one GET per session; a lookup touches one shard (two when a
 * subtree split). Shards are content-addressed, so they stay valid across
 * manifest updates and are cached in an LRU of eight.
 */

import { bytesToHex, errorMessage } from "../util";
import { contains, normalizePoint, type Point } from "./geo";
import { comparePaths, pathLetters } from "./paths";
import type { RegionSource } from "./source";
import {
  decodeManifestState,
  findEntry,
  parseManifest,
  parseShard,
  type Manifest,
  type ManifestEntry,
  type RegionRow,
} from "./wire";

const SHARD_CACHE_SIZE = 8;

export class ManifestUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestUnavailable";
  }
}

export class ManifestInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestInvalid";
  }
}

export class ShardMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShardMissing";
  }
}

export class ShardInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShardInvalid";
  }
}

export class NoPublishedCell extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoPublishedCell";
  }
}

export interface ChildCell {
  digit: number;
  letters: string;
  /** null when the child cell is not in the published dataset. */
  row: RegionRow | null;
}

export interface ResolvedCell {
  row: RegionRow;
  children: ChildCell[];
}

export interface PublishedAncestor {
  /** The published path that was found (shorter than the requested path when provisional). */
  path: number[];
  row: RegionRow;
  /** True when path.length < requested path length. */
  provisional: boolean;
}

export class RegionDataset {
  private readonly shards = new Map<string, Promise<RegionRow[]>>();
  private readonly order: string[] = [];

  private constructor(
    private readonly source: RegionSource,
    readonly manifest: Manifest,
  ) {}

  static async open(source: RegionSource): Promise<RegionDataset> {
    let state: Uint8Array;
    try {
      state = await source.getManifest();
    } catch (error) {
      throw new ManifestUnavailable(
        `region data is unavailable: ${errorMessage(error)}`,
      );
    }

    let payload: Uint8Array;
    try {
      payload = decodeManifestState(state).payload;
    } catch (error) {
      throw new ManifestInvalid(
        `region manifest is malformed: ${errorMessage(error)}`,
      );
    }

    let manifest: Manifest;
    try {
      manifest = parseManifest(payload);
    } catch (error) {
      throw new ManifestInvalid(
        `region manifest failed validation: ${errorMessage(error)}`,
      );
    }
    return new RegionDataset(source, manifest);
  }

  /** Published row for a path, or null when this depth is absent. */
  async lookupRow(path: readonly number[]): Promise<RegionRow | null> {
    // A path deeper than the published stage is absent by definition; never
    // derive a contract key the manifest cannot list.
    if (path.length === 0 || path.length > this.manifest.maxPathLen) {
      return null;
    }
    const entry = findEntry(this.manifest, path);
    if (!entry) return null;
    const index = this.manifest.entries.indexOf(entry);
    if (index < 0) return null;
    const rows = await this.loadShard(entry, index);
    return findRow(rows, path);
  }

  /**
   * The published row at `path`, or the nearest published prefix of it.
   * Root (and no published ancestor) yields null; the walk never looks deeper
   * than the manifest's published stage.
   */
  async nearestPublishedAncestor(
    path: readonly number[],
  ): Promise<PublishedAncestor | null> {
    if (path.length === 0) return null;

    if (path.length <= this.manifest.maxPathLen) {
      const row = await this.lookupRow(path);
      if (row) return { path: [...path], row, provisional: false };
    }

    const start = Math.min(path.length - 1, this.manifest.maxPathLen);
    for (let length = start; length >= 1; length -= 1) {
      const prefix = path.slice(0, length);
      const row = await this.lookupRow(prefix);
      if (row) return { path: prefix, row, provisional: true };
    }
    return null;
  }

  /** The eight child cells, with `row: null` for unpublished digits. */
  async childrenOf(path: readonly number[]): Promise<ChildCell[]> {
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_, digit) =>
        this.lookupRow([...path, digit]),
      ),
    );
    return rows.map((row, digit) => ({
      digit,
      letters: pathLetters([...path, digit]),
      row,
    }));
  }

  /**
   * Deepest published cell containing the point, plus its child cells.
   * A point outside every published cell throws `NoPublishedCell`.
   */
  async resolve(lat: number, lng: number): Promise<ResolvedCell> {
    const point: Point = normalizePoint(lat, lng);
    let current: RegionRow | null = null;

    for (let depth = 0; depth < this.manifest.maxPathLen; depth += 1) {
      const children = await this.childrenOf(current ? current.path : []);
      const next = children.find(
        ({ digit, row }) =>
          row !== null && contains(row, point, digit === 7),
      );
      if (!next?.row) break;
      current = next.row;
    }

    if (!current) {
      throw new NoPublishedCell(
        `no published region contains ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`,
      );
    }
    return { row: current, children: await this.childrenOf(current.path) };
  }

  private loadShard(entry: ManifestEntry, index: number): Promise<RegionRow[]> {
    const key = bytesToHex(entry.hash);
    const cached = this.shards.get(key);
    if (cached) {
      this.touch(key);
      return cached;
    }

    const promise = this.fetchShard(entry, index);
    this.shards.set(key, promise);
    this.order.push(key);
    this.trim();
    void promise.catch(() => {
      // A failed fetch must not poison the cache; a retry may succeed.
      if (this.shards.get(key) === promise) this.shards.delete(key);
      const position = this.order.indexOf(key);
      if (position >= 0) this.order.splice(position, 1);
    });
    return promise;
  }

  private async fetchShard(
    entry: ManifestEntry,
    index: number,
  ): Promise<RegionRow[]> {
    const codeHash = this.manifest.codeHashes[entry.codeHashId];
    if (!codeHash) {
      throw new ShardInvalid(
        `shard ${entry.letters} selects an unknown code hash`,
      );
    }
    const parameters = concat([
      new TextEncoder().encode("RGB1"),
      entry.hash,
    ]);
    let bytes: Uint8Array;
    try {
      bytes = await this.source.getShard(codeHash, parameters);
    } catch (error) {
      throw new ShardMissing(
        `shard ${entry.letters} is unavailable: ${errorMessage(error)}`,
      );
    }

    const nextStart = this.manifest.entries[index + 1]?.start ?? null;
    try {
      return parseShard(
        bytes,
        entry,
        this.manifest.maxPathLen,
        nextStart,
      );
    } catch (error) {
      throw new ShardInvalid(
        `shard ${entry.letters} failed validation: ${errorMessage(error)}`,
      );
    }
  }

  private touch(key: string): void {
    const position = this.order.indexOf(key);
    if (position >= 0) this.order.splice(position, 1);
    this.order.push(key);
  }

  private trim(): void {
    while (this.order.length > SHARD_CACHE_SIZE) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.shards.delete(oldest);
    }
  }
}

function findRow(
  rows: readonly RegionRow[],
  path: readonly number[],
): RegionRow | null {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const comparison = comparePaths(rows[middle]!.path, path);
    if (comparison === 0) return rows[middle]!;
    if (comparison < 0) low = middle + 1;
    else high = middle;
  }
  return null;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
