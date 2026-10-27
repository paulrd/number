/**
 * Committed migration registry.
 *
 * Never remove an entry: an old generation that is dropped from the registry is
 * unrecoverable. Order newest-first.
 *
 * Every generation that is superseded must be listed here so the UI can migrate
 * from it. That is enforced, not just documented:
 *   - `scripts/record-artifacts.sh` refuses to supersede a generation that is
 *     not registered here;
 *   - `migrations.test.ts` fails if any superseded generation recorded in
 *     `published/manifest.json` is missing from these lists, or if the committed
 *     artifact bytes no longer hash to the recorded values.
 * Both run in `make check` / CI, so an unregistered WASM change cannot land.
 * The active generation lives in `published/manifest.json`; add it here before
 * the next re-key (the record gate will insist).
 *
 * Delegate entries need the key, code hash, and the webapp id they were pinned
 * to. A successor can only recover a predecessor whose already-published WASM
 * answered `{"cmd":"export"}`; the first pinned delegate (key
 * `8GpT86YKAZoQeFDzWQhNZwHv6C73JqaNxd5KE48NY1Z8`) predates the handler and is
 * written off. The UI skips an entry whose key equals the active delegate, so
 * registering the active generation is harmless.
 *
 * A predecessor pinned to a different webapp id cannot be called from this UI:
 * its origin policy will refuse the request. Migrate the delegate before
 * changing the webapp id, or run the old UI to export it.
 */
export interface LegacyDelegate {
  /** Base58 delegate key. */
  key: string;
  /** Base58 delegate code hash. */
  codeHash: string;
  /** Base58 web container contract id the delegate was pinned to. */
  webappId: string;
}

export const LEGACY_DELEGATES: LegacyDelegate[] = [
  {
    key: "BPjm4EX38ag6SJG7ABA1H494nWCxVXo1GRM7UzC74SVX",
    codeHash: "7GQ6yxU9x7KKBKfGyTx5MJysQQJjbYj8WQsG6L42xedh",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
  {
    key: "4BBhEqP7m5aU3Z8UcDuWZ5ubc1jGZBSTwmxtSkca3SAE",
    codeHash: "FMjnDNpcFVEJs64iGffFXRktbQDF8f1HgGdDQZ4EHdKW",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
];

/**
 * Contract code hashes from which the current `number-contract` can migrate
 * state. The owner key is the stable anchor: the client derives each old
 * contract key as BLAKE3(old_code_hash || owner_pubkey), GETs the old state,
 * and PUTs it into the current contract, whose validation re-checks every
 * signature.
 *
 * Only add a hash when the new contract accepts the old state (same schema and
 * signing bytes). Append newest-first.
 */
export const LEGACY_CONTRACT_CODE_HASHES: string[] = [
  // Last build before the frozen path remap: its bytes embed the build
  // machine's cargo registry path, so the reproducible successor is a re-key.
  "3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd",
  // v1 contract, before the 2026-10 parameter-length message change.
  "7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez",
];
