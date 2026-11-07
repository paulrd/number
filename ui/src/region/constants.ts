/**
 * Live region manifest. Set both after the first stage publish:
 *
 * - `REGIONS_MANIFEST_INSTANCE`: the manifest contract instance id, base58
 *   (`BLAKE3(BLAKE3(raw manifest wasm) || params)`).
 * - `REGIONS_MANIFEST_CODE_HASH`: the **raw** manifest WASM hash, base58 — not
 *   the packaged file's hash.
 *
 * Empty values keep the live picker in "not published yet" mode. The offline
 * build uses the in-memory fixture and never reads these.
 */
export const REGIONS_MANIFEST_INSTANCE =
  "HyUU1CqeMhABSgCiomVFxkgEdXbWLaFJ2hLFbLGxHDU";
export const REGIONS_MANIFEST_CODE_HASH =
  "4DfUwwoSPpfEPW5sSRjBGVc44BfAB4xn5UckqcqgqPGx";
