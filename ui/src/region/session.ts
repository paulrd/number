/**
 * One lazily-opened region dataset per document.
 *
 * The picker, the map page and the onboarding panel all read the same
 * manifest and shards. Sharing the promise here keeps one network read and one
 * LRU instead of three, and keeps the "offline uses the fixture" decision in
 * one place. This module never imports Leaflet, so importing it does not pull
 * the map chunk.
 */

import {
  REGIONS_MANIFEST_CODE_HASH,
  REGIONS_MANIFEST_INSTANCE,
} from "./constants";
import { RegionDataset } from "./dataset";
import { buildFixture } from "./fixture";
import {
  BlobReader,
  ContractSource,
  FixtureSource,
  contractKeyFromInstance,
  type RegionSource,
} from "./source";

let datasetPromise: Promise<RegionDataset> | null = null;

/** Open (or reuse) the dataset. A failed open may be retried. */
export function openRegionDataset(): Promise<RegionDataset> {
  if (datasetPromise === null) {
    datasetPromise = Promise.resolve().then(() =>
      RegionDataset.open(createRegionSource()),
    );
    datasetPromise.catch(() => {
      datasetPromise = null;
    });
  }
  return datasetPromise;
}

/** The offline fixture or the live published manifest. */
export function createRegionSource(): RegionSource {
  if (import.meta.env.VITE_OFFLINE_MODE === "1") {
    const fixture = buildFixture();
    return new FixtureSource(fixture.manifestState, fixture.shards);
  }
  if (!REGIONS_MANIFEST_INSTANCE || !REGIONS_MANIFEST_CODE_HASH) {
    // The dataset client turns this into `ManifestUnavailable`, which every
    // caller renders as "the map is unavailable", never as a blank map.
    throw new Error("Region data is not published yet.");
  }
  return new ContractSource(
    new BlobReader(),
    contractKeyFromInstance(
      REGIONS_MANIFEST_INSTANCE,
      REGIONS_MANIFEST_CODE_HASH,
    ),
  );
}
