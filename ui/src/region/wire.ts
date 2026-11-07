/**
 * Region wire formats: manifest payload (region-manifest-v1) and shard payload
 * (region-v2), as defined in DESIGN-regions.md §6.
 *
 * The UI treats the manifest contract state as `seq || payload_len || payload ||
 * signature`. Signature verification belongs to the contract (the contract id
 * pins the publisher key); the client parses the envelope, verifies the shard
 * hashes, and validates every structural rule before rendering a row.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  comparePaths,
  packPath,
  pathLetters,
  unpackPath,
} from "./paths";

export const MANIFEST_MAGIC = new TextEncoder().encode("RGM1");
export const SHARD_MAGIC = new TextEncoder().encode("RGN1");
export const MANIFEST_VERSION = 1;
export const ROW_FORMAT = 2;
export const SHARD_VERSION = 2;
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const COORD_SCALE = 2 ** 22;
const MAX_LON = 180 * COORD_SCALE;
const MAX_LAT = 90 * COORD_SCALE;
const DATASET_DOMAIN = new TextEncoder().encode("number:regions:dataset:v1");
const ENVELOPE_HEADER = 12;
const SIGNATURE_LEN = 64;

export interface ManifestEntry {
  /** Decoded digits (0–7). */
  start: number[];
  /** The same path as a–h, for display and comparison in tests. */
  letters: string;
  codeHashId: number;
  rows: number;
  bytes: number;
  hash: Uint8Array;
}

export interface Manifest {
  datasetId: Uint8Array;
  rowFormat: number;
  codeHashes: Uint8Array[];
  totalRows: number;
  maxPathLen: number;
  entries: ManifestEntry[];
}

export interface ManifestState {
  seq: number;
  payload: Uint8Array;
  signature: Uint8Array;
}

export interface RegionRow {
  path: number[];
  letters: string;
  /** Degrees. */
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  population: number;
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }

  u32(): number {
    this.require(4);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    );
    this.offset += 4;
    return view.getUint32(0, true);
  }

  i32(): number {
    this.require(4);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    );
    this.offset += 4;
    return view.getInt32(0, true);
  }

  u64(): number {
    this.require(8);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    this.offset += 8;
    const value = view.getBigUint64(0, true);
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new Error("region manifest: 64-bit value exceeds the safe integer range");
    }
    return asNumber;
  }

  take(length: number): Uint8Array {
    this.require(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private require(length: number): void {
    if (this.offset + length > this.bytes.length) {
      throw new Error("region payload ended before the declared length");
    }
  }
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

function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Split `seq || payload_len || payload || signature`; the signature is not verified here. */
export function decodeManifestState(state: Uint8Array): ManifestState {
  if (state.length < ENVELOPE_HEADER + SIGNATURE_LEN) {
    throw new Error("region manifest: state is too short");
  }
  const view = new DataView(state.buffer, state.byteOffset, state.length);
  const seq = Number(view.getBigUint64(0, true));
  const payloadLength = view.getUint32(8, true);
  const expected = ENVELOPE_HEADER + payloadLength + SIGNATURE_LEN;
  if (state.length !== expected) {
    throw new Error(
      `region manifest: state is ${state.length} bytes, envelope declares ${expected}`,
    );
  }
  if (payloadLength > 4 * 1024 * 1024) {
    throw new Error("region manifest: payload exceeds 4 MiB");
  }
  return {
    seq,
    payload: state.subarray(ENVELOPE_HEADER, ENVELOPE_HEADER + payloadLength),
    signature: state.subarray(ENVELOPE_HEADER + payloadLength),
  };
}

export function parseManifest(payload: Uint8Array): Manifest {
  const reader = new Reader(payload);
  if (!equals(reader.take(4), MANIFEST_MAGIC)) {
    throw new Error("region manifest: bad magic");
  }
  const version = reader.u8();
  if (version !== MANIFEST_VERSION) {
    throw new Error(`region manifest: unsupported version ${version}`);
  }
  const datasetId = reader.take(16);
  const rowFormat = reader.u8();
  if (rowFormat !== ROW_FORMAT) {
    throw new Error(`region manifest: unsupported row format ${rowFormat}`);
  }
  const codeHashCount = reader.u8();
  if (codeHashCount === 0) {
    throw new Error("region manifest: no shard code hashes");
  }
  const codeHashes: Uint8Array[] = [];
  for (let index = 0; index < codeHashCount; index += 1) {
    codeHashes.push(reader.take(32));
  }
  const totalRows = reader.u64();
  const maxPathLen = reader.u8();
  if (maxPathLen === 0 || maxPathLen > 32) {
    throw new Error(`region manifest: invalid max path length ${maxPathLen}`);
  }
  const shardCount = reader.u32();
  if (shardCount === 0) {
    throw new Error("region manifest: no shards");
  }

  const entries: ManifestEntry[] = [];
  for (let index = 0; index < shardCount; index += 1) {
    const startLen = reader.u8();
    if (startLen === 0 || startLen > maxPathLen) {
      throw new Error(`region manifest: entry ${index} has an invalid start length`);
    }
    const packedLength = Math.ceil((3 * startLen) / 8);
    const start = unpackPath(reader.take(packedLength), startLen);
    const codeHashId = reader.u8();
    if (codeHashId >= codeHashCount) {
      throw new Error(`region manifest: entry ${index} selects an unknown code hash`);
    }
    const rows = reader.u32();
    const bytes = reader.u32();
    if (rows === 0) {
      throw new Error(`region manifest: entry ${index} is empty`);
    }
    if (bytes === 0 || bytes > MAX_BLOB_BYTES) {
      throw new Error(`region manifest: entry ${index} has an invalid size`);
    }
    const hash = reader.take(32);
    if (entries.length > 0) {
      const previous = entries[entries.length - 1]!;
      if (comparePaths(previous.start, start) >= 0) {
        throw new Error("region manifest: shard starts are not strictly increasing");
      }
    }
    entries.push({
      start,
      letters: pathLetters(start),
      codeHashId,
      rows,
      bytes,
      hash,
    });
  }
  if (reader.remaining !== 0) {
    throw new Error(`region manifest: ${reader.remaining} trailing bytes`);
  }

  const sumRows = entries.reduce((sum, entry) => sum + entry.rows, 0);
  if (sumRows !== totalRows) {
    throw new Error(
      `region manifest: entries hold ${sumRows} rows, header says ${totalRows}`,
    );
  }

  const preimage = concat([
    DATASET_DOMAIN,
    le32(shardCount),
    ...entries.flatMap((entry) => [packPath(entry.start), entry.hash]),
  ]);
  const expectedId = blake3(preimage).subarray(0, 16);
  if (!equals(datasetId, expectedId)) {
    throw new Error("region manifest: dataset id does not match the entries");
  }

  return { datasetId, rowFormat, codeHashes, totalRows, maxPathLen, entries };
}

/** Greatest entry whose start is <= `path`, or null when the path precedes the first shard. */
export function findEntry(
  manifest: Manifest,
  path: readonly number[],
): ManifestEntry | null {
  let low = 0;
  let high = manifest.entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comparePaths(manifest.entries[middle]!.start, path) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low === 0 ? null : manifest.entries[low - 1]!;
}

/**
 * Verify and parse a shard. `nextStart` is the next entry's start (or null for
 * the last shard, which has no upper bound).
 */
export function parseShard(
  bytes: Uint8Array,
  entry: ManifestEntry,
  maxPathLen: number,
  nextStart: readonly number[] | null,
): RegionRow[] {
  if (bytes.length !== entry.bytes) {
    throw new Error(
      `region shard: ${bytes.length} bytes, manifest says ${entry.bytes}`,
    );
  }
  if (!equals(blake3(bytes), entry.hash)) {
    throw new Error("region shard: content hash does not match the manifest");
  }

  const reader = new Reader(bytes);
  if (!equals(reader.take(4), SHARD_MAGIC)) {
    throw new Error("region shard: bad magic");
  }
  const version = reader.u8();
  if (version !== SHARD_VERSION) {
    throw new Error(`region shard: unsupported version ${version}`);
  }
  const rowCount = reader.u32();
  if (rowCount !== entry.rows) {
    throw new Error(
      `region shard: ${rowCount} rows, manifest says ${entry.rows}`,
    );
  }

  const rows: RegionRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const pathLen = reader.u8();
    if (pathLen === 0 || pathLen > maxPathLen) {
      throw new Error(`region shard: row ${index} has an invalid path length`);
    }
    const path = unpackPath(reader.take(Math.ceil((3 * pathLen) / 8)), pathLen);
    const minLon = reader.i32();
    const maxLon = reader.i32();
    const minLat = reader.i32();
    const maxLat = reader.i32();
    const population = reader.u32();

    if (minLon > maxLon || minLat > maxLat) {
      throw new Error(`region shard: row ${index} has inverted bounds`);
    }
    if (
      Math.abs(minLon) > MAX_LON ||
      Math.abs(maxLon) > MAX_LON ||
      Math.abs(minLat) > MAX_LAT ||
      Math.abs(maxLat) > MAX_LAT
    ) {
      throw new Error(`region shard: row ${index} has out-of-world bounds`);
    }

    if (index === 0) {
      if (comparePaths(path, entry.start) !== 0) {
        throw new Error("region shard: first row does not match the entry start");
      }
    } else {
      const previous = rows[rows.length - 1]!;
      if (comparePaths(previous.path, path) >= 0) {
        throw new Error(`region shard: row ${index} is out of order`);
      }
    }
    if (comparePaths(path, entry.start) < 0) {
      throw new Error(`region shard: row ${index} precedes the shard start`);
    }
    if (nextStart !== null && comparePaths(path, nextStart) >= 0) {
      throw new Error(`region shard: row ${index} reaches the next shard`);
    }

    rows.push({
      path,
      letters: pathLetters(path),
      minLon: minLon / COORD_SCALE,
      maxLon: maxLon / COORD_SCALE,
      minLat: minLat / COORD_SCALE,
      maxLat: maxLat / COORD_SCALE,
      population,
    });
  }

  if (reader.remaining !== 0) {
    throw new Error(`region shard: ${reader.remaining} trailing bytes`);
  }
  return rows;
}
