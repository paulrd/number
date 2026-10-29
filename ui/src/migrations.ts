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
    // v7: the payments/parent delegate superseded by v8 auto-advance. Verified
    // against published/manifest.json (recorded generation) and
    // DELEGATE_VERSION = 7 in delegate/src/lib.rs. Its seed and all counters
    // (including paymentsNextSeq) carry forward; register it before the v8 key
    // changes so the migration path exists before configure runs.
    key: "6FN3m31BPRFVjFdKVDE4jNReq6cfon4mXFcpdmaaBEv1",
    codeHash: "48A8jNz39wP1xx5oLRUvRgG8qxjxzmfkErCZp4j7kRhw",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
  {
    // The first v4 build (payments without the settled-id list). It was
    // recorded locally but never deployed; its board schema is not migratable
    // to the settled v4. Its seed/counters still carry forward.
    key: "8ChETsjiDWRDQ9C696EvDM81hUidjPgikpKrcA8LJPwx",
    codeHash: "7R5J4SQErkVKVzkWaG7cPfQFbRva1GpaVTRTGcKQ4tmc",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
  {
    // v3 (tree parent link). v4 adds the payments record; the seed and all
    // counters carry forward, with paymentsNextSeq defaulting to 1.
    key: "FtdTGtdvZT3j71nr8yF2L7qsqdLTdwKrWfjMSoPg7iEb",
    codeHash: "FHGW7JXm4XPdTo5ezG5wThTd6CCVAEmQEFM8vJB1mdjH",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
  {
    key: "BN6Egqx27gcue4VNyDs4Qqt8uzYwVZsphfS62RKKcNef",
    codeHash: "CmXAPVyVH7MmEp3apB89sCkQsgqje5cZXxzuQHCmeVNj",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
  {
    key: "3ViRVk2ScELVVmk4bjJVWS33dD6SiSmTbSQ1b8yDHVdZ",
    codeHash: "7SMgeUTjfdkYtay446EVLruxSwukeYKTozHiPSxUeKDY",
    webappId: "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k",
  },
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
 *
 * v3 (tree parent link) keeps the v2 slot and contacts signing bytes, so a v2
 * state is upgraded by the client (add an empty parent, set `v: 3`) and re-PUT
 * into v3. The v2 generation is therefore migratable. v1 boards changed the
 * slot schema/signing bytes and remain unmigratable.
 */
export const LEGACY_CONTRACT_CODE_HASHES: string[] = [
  // v4 (payments). v5 adds an empty adjustments record; every existing slot,
  // contacts, parent and payments signature remains valid.
  "C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT",
  // v3 (tree parent link). v4 adds an empty payments record; slot/contacts/
  // parent signatures remain valid.
  "7j8ycU22TP9CfgGCk1nztWe6nqiasM6TS71Lg2fj9WPg",
  // v2 (address book + hundredths). v3 adds an empty parent; slot/contacts
  // signatures remain valid.
  "A1J4T4sJ4xwRtbbu8QpXhCSyMHrW1uMp2H4H5BfBdiur",
];

/**
 * Superseded contract generations whose state the current contract cannot
 * accept. They still have to be registered (the record gate and
 * `migrations.test.ts` require every superseded generation to be accounted
 * for), but the UI must not try to migrate from them: their signatures cover a
 * different schema, so the current `validate_state` would reject the PUT.
 *
 * The user-visible consequence is documented in README/DESIGN: a v1 board is
 * not carried into v2. The owner identity is carried forward by the delegate,
 * so the new board is the same owner with an empty address book and slots.
 * Append newest-first; never remove an entry.
 */
export const UNMIGRATABLE_CONTRACT_CODE_HASHES: string[] = [
  // First v4 build (payments without settled). Recorded but never deployed;
  // the settled v4 schema/signing bytes differ.
  "6h9ugwNX5JxgXhadYvvLp8Eu1jPMRe46zXQnAKrRpt57",
  // v1 before the address book: v2 state/signing bytes are incompatible.
  "6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX",
  // Last build before the frozen path remap: its bytes embed the build
  // machine's cargo registry path, so the reproducible successor is a re-key.
  "3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd",
  // v1 contract, before the 2026-10 parameter-length message change.
  "7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez",
];
