/**
 * A tiny complete region dataset for tests and offline mode.
 *
 * Eight depth-1 cells (a–h) and eight children each, all in one shard. Bounds
 * tile: depth-1 cells split longitude 0..180 into eight bands of 22.5 degrees
 * and span latitude 0..45; each child splits its parent 4×2. This is sample
 * data, not the real world.
 */

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "../util";
import { packPath } from "./paths";
import { COORD_SCALE } from "./wire";

export interface FixtureDataset {
  manifestState: Uint8Array;
  shards: Map<string, Uint8Array>;
}

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function le64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
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

function encodeCoordinate(value: number): number {
  const encoded = Math.round(value * COORD_SCALE);
  if (encoded % 4 !== 0) {
    throw new Error(`fixture coordinate ${value} is not a 2^-20 multiple`);
  }
  return encoded;
}

function encodeRow(
  path: readonly number[],
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
  population: number,
): Uint8Array {
  const packed = packPath(path);
  const out = new Uint8Array(1 + packed.length + 20);
  out[0] = path.length;
  out.set(packed, 1);
  const view = new DataView(out.buffer);
  let offset = 1 + packed.length;
  view.setInt32(offset, encodeCoordinate(minLon), true);
  view.setInt32(offset + 4, encodeCoordinate(maxLon), true);
  view.setInt32(offset + 8, encodeCoordinate(minLat), true);
  view.setInt32(offset + 12, encodeCoordinate(maxLat), true);
  view.setUint32(offset + 16, population, true);
  return out;
}

export function buildFixture(): FixtureDataset {
  const rows: Uint8Array[] = [];
  let population = 0;

  for (let band = 0; band < 8; band += 1) {
    const minLon = band * 22.5;
    const maxLon = (band + 1) * 22.5;
    rows.push(encodeRow([band], minLon, maxLon, 0, 45, population));
    population += 1;

    const lonStep = 22.5 / 4;
    const latStep = 45 / 2;
    for (let child = 0; child < 8; child += 1) {
      const column = child % 4;
      const row = Math.floor(child / 4);
      rows.push(
        encodeRow(
          [band, child],
          minLon + column * lonStep,
          minLon + (column + 1) * lonStep,
          row * latStep,
          (row + 1) * latStep,
          population,
        ),
      );
      population += 1;
    }
  }

  const header = new Uint8Array(9);
  header.set(ascii("RGN1"));
  header[4] = 2;
  new DataView(header.buffer).setUint32(5, rows.length, true);
  const shard = concat([header, ...rows]);
  const hash = blake3(shard);

  const codeHash = new Uint8Array(32).fill(0x11);
  const start = packPath([0]);
  const datasetId = blake3(
    concat([ascii("number:regions:dataset:v1"), le32(1), start, hash]),
  ).subarray(0, 16);

  const payload = concat([
    ascii("RGM1"),
    Uint8Array.of(1),
    datasetId,
    Uint8Array.of(2, 1),
    codeHash,
    le64(rows.length),
    Uint8Array.of(2),
    le32(1),
    Uint8Array.of(start.length),
    start,
    Uint8Array.of(0),
    le32(rows.length),
    le32(shard.length),
    hash,
  ]);

  const state = new Uint8Array(12 + payload.length + 64);
  const view = new DataView(state.buffer);
  view.setBigUint64(0, 1n, true);
  view.setUint32(8, payload.length, true);
  state.set(payload, 12);

  return {
    manifestState: state,
    shards: new Map([[bytesToHex(hash), shard]]),
  };
}
