# Region stage 1, the two contracts, and the picker — implementation spec (P1)

Status: implemented, 2026-11-07. Stage 1 is published and verified; the
website is not yet republished with the picker. Implements P1 of
`DESIGN-network.md`. Formats are from `DESIGN-regions.md` §5–§6; this document
does not change them.

Scope: a published depth-≤7 dataset, the two small contract crates, the
exporter/publisher, and a picker that resolves a point to a cell and shows its
children. No zone contract change (`DESIGN-network.md` §2). No onboarding, no
zones, no rooms.

---

## 0. Definition of done

1. `region-blob` and `region-manifest` are built, tested, and published.
2. The exporter reproduces, for the real `trie.db` with `--max-depth 7`:

   | | |
   | --- | ---: |
   | rows | 1,481,182 |
   | row bytes (packed rows) | 35,517,561 |
   | shard files | 35,519,163 (row bytes + 9 per shard) |
   | shards | 178 |
   | average shard | 199,536 row bytes |
   | largest shard | 262,021 row bytes (262,030 file bytes) |
   | manifest payload | 7,847 B |

3. All 178 shards and the manifest verify from a second node.
4. In the UI, a click anywhere on the map shows the region path, depth,
   bounds, population, and the eight published children. Cold: manifest plus at
   most three shard GETs (usually manifest + one). Warm: manifest cached, at
   most two.
5. The offline e2e suite passes with a fixture dataset and no external request.

### Progress (2026-11-07)

- `region/wire`, `region/blob`, `region/manifest`, `region/tool` implemented;
  22 Rust tests (4 + 6 + 7 + 5) and 24 region TypeScript tests (271 UI tests
  total), `cargo fmt --check` and `clippy -D warnings` clean. CI has a `regions`
  job; `make check` runs `regions-check`.
- **Exporter acceptance reached on the real database**: 1,481,182 rows,
  35,517,561 row bytes, 178 shards, 27 s; largest shard 262,021 row bytes
  (262,030 file bytes), manifest payload 7,847 B. It reproduces Appendix A.3
  exactly.
- `sign`, `publish` and `verify` are implemented. `publish` has a resumable
  ledger, retries each PUT, verifies every shard by GET, and publishes or
  updates the manifest last. Live end-to-end with the 4-shard fixture: published
  to 7509 and verified from 7511 (shards + manifest). The test manifest used an
  ephemeral key (`BzasDcLJ…`), so it is not a UI constant and must not be
  reused; the full 178-shard publish awaits the real publisher key.
- `make regions-wasm` builds both contracts through `scripts/build.sh` with the
  frozen remap and copies packaged + raw artifacts to `.build/regions/`.
  Repeated builds produce the same hashes.
- Canonical code hashes for this source (raw WASM): blob
  `H1u41bZHHy9zN19QJK3kGCmEBhFhzmh86k4GJqiMiSxN`, manifest
  `4DfUwwoSPpfEPW5sSRjBGVc44BfAB4xn5UckqcqgqPGx`. The packaged files hash
  differently; never use those bytes as the code hash.
- Golden fixture committed in `fixtures/regions/` (72-row tree, 4 shards),
  reproduced byte-for-byte by the tool test; it is the cross-language input for
  the TypeScript parser.
- **UI dataset client and picker implemented.** `RegionDataset` fetches the
  manifest once, caches up to eight shards, verifies every shard, and answers
  `lookupRow`, `childrenOf` and `resolve(lat,lng)`. The picker is a Leaflet
  EPSG:4326 map with no tile layer, vendored `countries-110m`, an accessible
  coordinate form, and a child-region table. It is lazy-loaded from the
  Advanced "Where this zone sits" block.
- Offline e2e covers the picker: resolve `(1,1)` to `aa`, eight child rows,
  Axe-clean, **zero external requests** (24 offline tests pass).
- Live read smoke: `ui/e2e/live-region.mjs` GETs the test manifest from 7509
  and from 7511 (316 bytes, seq 1), using the same key construction as
  `BlobReader`.
- **Stage 1 published live (2026-11-07).** 178 shards and manifest
  `HyUU1CqeMhABSgCiomVFxkgEdXbWLaFJ2hLFbLGxHDU` (seq 1, publisher verifying key
  `2d996f41fce12cdc25b9d742edb57e247a5af693867bebb86b126d7b3c11ed07`) to node
  7509 in 2m50s. Verified the 8-shard sample from 7511 and **all 178 shards plus
  the manifest from 7512** (179 checks, exit 0). Live browser smoke through the
  dev proxy: `(69,179)` → `aacbea` (octal `002140`, depth 6, eight child rows,
  no console errors). The UI constants now hold the manifest id and the raw
  manifest code hash.
- Remaining: republish the website so the picker is live for users (dataset and
  constants are ready). Then P2.

---

## 1. Out of scope

- Reading or writing zones, addresses, or slot assignments (P2).
- The join queue, candidate room, members room, or `?root=` (P3/P4).
- Provisional cells beyond the published depth in the picker (P2; P1 shows the
  deepest published cell and says detail ends there).
- Manifest updates beyond `seq = 1` (the publisher supports `--seq`, but no
  stage-2 workflow is built).

---

## 2. Repository layout

```
region/            # singular: `/regions/` is the generated-data ignore
  wire/            # shared manifest payload + envelope codecs (host + contract)
  blob/            # region-blob contract WASM (standalone crate)
  manifest/        # region-manifest contract WASM (standalone crate)
  tool/            # exporter, signer, publisher, verifier (host binary)
```

- `blob` and `manifest` are standalone crates with their own `Cargo.lock` and
  `[workspace]`, like `contract/` and `delegate/`. Their dependency versions are
  pinned so a rebuild reproduces the WASM hash. Only `manifest` depends on
  `wire` (path dependency); `blob` is opaque and must stay minimal.
- Each carries a `freenet.toml` like `contract/`. `fdev build` produces the
  **packaged** artifact (a single file, not raw cargo output); that packaged
  file is the `--code` input for `publish`.
- **The code hash is BLAKE3 of the raw WASM**, not of the packaged file (the
  package embeds a container). `regions-wasm` copies both: `blob.wasm` /
  `manifest.wasm` (packaged, for `--code`) and `blob.code.wasm` /
  `manifest.code.wasm` (raw, for hashing and the manifest's code-hash table).
  Verified against `fdev get-contract-id`: raw hash `H1u41…` and packaged file
  yield the same contract id; hashing the packaged file does not.
- The placeholder initial state in `freenet.toml` is never published: every
  shard and the manifest pass `--state` explicitly.
- `tool` is a normal host crate; its dependencies never affect a WASM hash.
- `scripts/build.sh` gained `--crate blob|manifest|regions`; both region crates
  use the same frozen path remap as the app contract and delegate, so their
  hashes are reproducible and portable.
- `wire` is `no_std`-free plain Rust: it only parses and encodes bytes.

Makefile targets (added next to the existing contract/delegate targets):

```make
regions-wasm:      # (cd region/blob && fdev build), likewise manifest
regions-tool:      # cargo build -p regions-tool
regions-export:    # tool export --db trie.db --out .build/regions --max-depth 7
regions-publish:   # tool publish --node ws://127.0.0.1:7510
regions-verify:    # tool verify --node ws://127.0.0.1:7510 --sample 8
```

`make check` gains the two contract test suites and the tool's unit tests.
`regions-export` and `regions-publish` stay out of CI: they need the 13 GB
database and a signing key.

---

## 3. `region-blob` contract

Generic immutable content-addressed blob; reusable for any bytes.

**Parameters** (36 bytes): `"RGB1"` + BLAKE3(state).

**State**: arbitrary bytes, `<= 8 MiB`.

**Interface**

- `validate_state`: parameters are exactly 36 bytes with the magic; state
  length `<= 8 MiB`; `BLAKE3(state) == params[4..36]`.
- `update_state`: stage every `UpdateData::State`, `StateAndDelta`, and bare
  `Delta` — the delta returned by `get_state_delta` **is** the full state bytes,
  so a delta is parsed as a full blob and accepted only when its hash equals
  the parameter hash. If the chosen bytes equal the current state, return
  `UpdateModification::valid(current)` (no-op). Anything else is
  `ContractError::InvalidUpdate`.
- `summarize_state`: the 32-byte content hash from the parameters.
- `get_state_delta`: if the summary equals the content hash, return an empty
  delta; otherwise return the full state.

**Tests**

- wrong magic / wrong parameter length / oversized state → `Invalid`;
- hash mismatch → `Invalid`;
- a valid state validates, a replayed identical state is a no-op;
- a different valid state (different params) is impossible in one instance;
- summary is stable; delta is empty when converged and full otherwise.

No merge concern: the admissible set is a singleton.

---

## 4. `region-manifest` contract

Publisher-owned signed last-writer-wins register with a monotonic sequence.

**Parameters** (52 bytes): `"MGB1"` + publisher Ed25519 verifying key (32) +
namespace (16, `BLAKE3("number:regions")[..16]`).

**State**

```
seq            u64 LE, > 0
payload_len    u32 LE, <= 4 MiB
payload        payload_len bytes
signature      64 bytes Ed25519
```

**Signature domain**

```
"number:region-manifest:v1" || parameters || seq_LE || payload
```

The domain and parameters bind the signature to this contract family and stop a
manifest signed for another publisher or namespace from being replayed.

**Interface**

- `validate_state`: parameter magic/length, `seq > 0`,
  `payload_len <= 4 MiB`, exact length, signature verifies.
- `update_state`: decode and validate every incoming candidate (the host does
  not promise pre-validated updates), then choose the greatest
  `(seq, BLAKE3(full_state_bytes))`. Accept `State`, `StateAndDelta`, and bare
  `Delta`; because `get_state_delta` returns the full state, a bare delta is
  parsed as a full envelope. Lower `seq` never wins. Tie-break on the **full
  state hash**, not the payload hash: two valid signatures over the same
  payload must otherwise never diverge while their summaries match.
- `summarize_state`: `seq_LE (8) || BLAKE3(full_state_bytes) (32)` = 40 bytes.
- `get_state_delta`: parse the summary key; an empty or undecodable summary is
  a new subscriber, so return the full state; if the key is `>=` ours, return
  empty (never send a downgrade); otherwise return the full state.

**Tests**

- valid signature accepted; tampered payload, seq, params, or domain rejected;
- lower `seq` never replaces higher, even with a lexicographically greater hash;
- equal `seq`, different payload → greater full-state hash wins, deterministically;
- equal `seq`, same payload, different signature bytes → full-state hash breaks
  the tie, so peers converge;
- a bare `Delta` carrying the full envelope is accepted and merged like a
  `State`; a truncated delta is rejected;
- summary round-trip; delta empty for an equal-or-newer peer, full for an older
  one;
- payload larger than 4 MiB, `seq = 0`, truncated envelope → `Invalid`.

---

## 5. Wire formats

Copied here as the implementation checklist; `DESIGN-regions.md` §6 is the
authority.

### 5.1 Shard payload (`region-v2`)

```
magic            4   "RGN1"
format_version   1   2
row_count        4   u32 LE
rows             row_count × Row
```

Row: `path_len u8` (1..=32), `path_packed ceil(3*len/8)`, then
`min_lon i32`, `max_lon i32`, `min_lat i32`, `max_lat i32`,
`population u32`, all little-endian.

- Path digits are 0–7 (`a`–`h` mapped), three bits each, most-significant bit
  first, zero-padded in the last byte.
- Coordinates are signed fixed point with scale **2^22**.
- Population is whole people; `0` is valid.
- The header is **9 bytes** (magic 4 + version 1 + row count 4). The 256 KiB
  target applies to row bytes, so a full shard file is at most target + 9.

### 5.2 Manifest payload (`region-manifest-v1`)

```
magic            4   "RGM1"
format_version   1   1
dataset_id       16
row_format       1   2
code_hash_count  1
code_hashes      count × 32
total_rows       8   u64 LE
max_path_len     1
shard_count      4   u32 LE
entries          shard_count × Entry
```

Entry: `start_len u8`, `start_packed`, `code_hash_id u8`, `rows u32`,
`bytes u32`, `content_hash 32`. Entry `i` covers `[start_i, start_{i+1})`; the
last covers `[start_last, ∞)`.

- `dataset_id` = `BLAKE3("number:regions:dataset:v1" || shard_count_LE ||
  concat(start_packed || content_hash))[..16]`. Deterministic across reruns.
- `max_path_len` = the deepest path present (7 here), not the format limit.
- `code_hash_count = 1` at first; each hash is `BLAKE3(raw shard WASM)`, never
  the packaged file's hash. The table is the shard-WASM upgrade escape hatch.

### 5.3 Contract ids

`id = BLAKE3(BLAKE3(wasm) || parameters)`, base58. The manifest key is stable
across `seq` updates and is committed in the UI.

---

## 6. Exporter

`regions-tool export --db <path> --out <dir> --max-depth 7 --target 262144
--blob-code-wasm <raw region_blob.wasm>`.

### 6.1 Pass 1 — order and boundaries

Read-only (`file:...?mode=ro`, `PRAGMA query_only=ON`), with **one read
transaction open across both passes** (or a snapshot copy) so the two scans see
the same rows. For a truncated stage the tree is small enough to index in memory
(1.48M rows, ~60 MB); the full-stage streaming variant is future work (§13).

1. `SELECT materialized_path FROM region WHERE length(materialized_path) <= :max
   ORDER BY materialized_path`.
2. `bytes[i] = 21 + ceil(3*len(path_i)/8)` (1 path length + 16 bounds + 4
   population).
3. Subtree end: first `j > i` whose path is not prefixed by `path_i`. One
   forward stack, `O(rows)`.
4. Prefix sums `pref` over `bytes` (u64).
5. Pack, exactly as `DESIGN-regions.md` §4:

```
pack_subtree(i):
  if bytes(i..end_i) <= T or no children: return [(i, end_i)]
  units = [(i, i+1)]                      # the node's own row
  for each direct child c:
      if bytes(c..end_c) <= T: units.push((c, end_c))
      else:                    units.extend(pack_subtree(c))
  bundle consecutive units while total <= T
  return bundles
```

Top level: a virtual world root with the depth-1 rows as children; bundle them.
Every shard's start path is its first row.

**Assertions** (abort export on failure): rows = 1,481,182; bytes =
35,517,561; shards = 178; every shard `<= 262,144` B; starts strictly
increasing; ranges contiguous and cover every row; `sum(entry.rows) =
total_rows`.

### 6.2 Pass 2 — encode

The row pass asks SQLite for **quantized integers**, never floats:

```sql
SELECT materialized_path,
       CAST(round(min_lon * 4194304) AS INTEGER), ...
FROM region WHERE length(materialized_path) <= :max
ORDER BY materialized_path
```

That removes the float-to-text round trip: CSV with 15 significant digits
cannot represent every `2^-20` multiple. Fail if any coordinate is not a
multiple of 4 (a `2^-20` multiple at scale `2^22`), is outside the world, or has
inverted bounds. Population: round, reject `< 0` or `> u32::MAX`; never clamp.

Write the manifest payload after the shards; do not sign yet.

### 6.3 Output layout (all under an ignored directory)

```
.build/regions/
  blob.wasm                     # packaged artifact (--code)
  blob.code.wasm                # raw WASM (BLAKE3 source for ids)
  manifest.wasm                 # packaged artifact (--code)
  manifest.code.wasm            # raw WASM
  shards/000000.bin … 000177.bin
  params/000000.bin …            # "RGB1" || content_hash
  manifest.payload.bin           # unsigned payload
  manifest.params.bin
  manifest.bin                   # signed envelope (after `sign`)
  index.json                     # starts, rows, bytes, hashes (verification)
  ledger.jsonl                   # publish status (after `publish`)
```

Deterministic: the same DB, depth, target, and WASM produce byte-identical
shards, manifest payload, and signature (Ed25519 is deterministic).

### 6.4 `sign`

Read the publisher seed from `REGIONS_PUBLISHER_SEED` (64 hex) or `--key-file`,
refuse paths inside the repository, print the verifying key, encode the
envelope with `seq` (default 1), and write `manifest.bin`. Never write the key.

---

## 7. Publisher and verification

`regions-tool publish --out .build/regions --port 7510 --workers 3`.
`--fdev` selects the binary; `--dry-run` prints the ids without publishing.

1. For each shard: derive the key locally, skip if the ledger says `ok`, run

   ```bash
   fdev --port 7510 publish \
     --code .build/regions/blob.wasm \
     --parameters .build/regions/params/000123.bin \
     contract --state .build/regions/shards/000123.bin
   ```

   then `fdev --port 7510 execute get <key> -o got.bin`, compare
   `BLAKE3(got) == content_hash`, append the ledger entry. A failure is
   recorded and the run continues; a rerun resumes.
2. Only when every shard is `ok`: publish the manifest the same way (it is a
   new contract at `seq` 1; later stages use
   `fdev execute update <key> manifest.bin --as-state`).
3. Print the manifest key. Commit it in `ui/src/region/constants.ts`.

Sanity: `fdev get-contract-id --code blob.wasm --parameters params/000000.bin`
must match the locally derived id for at least one shard.

`regions-tool verify --out ... --port 7511 --sample 8` (or `--all`) re-GETs
sampled shards plus the manifest, checks hashes, checks each shard header and
row count, and compares the manifest bytes.

Live-tested 2026-11-07: the 4-shard fixture was published to node 7509 and
verified from node 7511 (all shards plus the manifest). The manifest was
published last, and `publish --state` correctly overrode the packaged
placeholder state.

---

## 8. UI dataset client

New folder `ui/src/region/`; keep `freenet.ts` unchanged except for one exported
helper if needed.

```
paths.ts     # digit packing, logical compare, prefix, path→address
wire.ts      # manifest and shard codecs (strict)
geo.ts       # point→cell, bounds, normalization
source.ts    # RegionSource interface; ContractSource; FixtureSource
dataset.ts   # fetch, verify, cache, lookup, children
picker.ts    # Leaflet view and dialog controller
```

### 8.1 Blob reader

`NumberContract` is single-key and decodes zone state; do not reuse it. Add a
`BlobReader` over one `FreenetWsApi` connection:

- `read(key: ContractKey, timeoutMs): Promise<Uint8Array>`;
- a `Map<instanceBase58, {resolve, reject, timer}>` of in-flight GETs;
- `onContractGet` resolves only the matching key; `onContractNotFound` rejects
  with `ContractNotFoundError`; a timeout rejects and deletes the entry;
- at most 3 concurrent reads; one connection for the session;
- no retries on the manifest; one retry with a 300 ms delay for a shard.

### 8.2 Parsing and verification

- Verify `BLAKE3(shardBytes) == entry.content_hash` **before** parsing.
- Strict parse: magic, version, exact byte consumption, `rows[0].path ==
  entry.start`, every path inside `[start, nextStart)`, sorted and unique,
  `min <= max`, coordinates inside the world, `population` any `u32`.
- On failure return `ShardInvalid`; never render unverified rows.

### 8.3 Path compare

Compare decoded digit arrays digit by digit; a shorter prefix sorts first. Do
**not** compare packed bytes: padding makes them non-unique across lengths (`a`
and `aa` both pack to `0x00`; `b` and `ba` both to `0x20`), so a byte compare
cannot tell a prefix from its extension. Always decode with the length.

### 8.4 Lookup

```
lookupRow(path) -> entry = manifest.greatestStartAtOrBefore(path)
                 -> shard = cache.get(entry) or fetch+parse
                 -> shard.findRow(path)        # binary search in the shard
childrenOf(path) -> for digit 0..7: lookupRow(path+digit), keep hits
cellAt(lat,lng)  -> p = "" ; loop:
                      kids = childrenOf(p).filter(contains(lat,lng))
                      if kids.empty: return cell(p)
                      p = kids[0].path
```

- `contains` uses half-open `[min, max)` on lat and lon, except the numerically
  highest digit, which includes its max edges; children tile the parent, so
  exactly one matches.
- Normalize the click: `lat` clamped to `[-90, 90]`; `lon` wrapped into
  `[-180, 180)`. A map wrapped copy must not produce `lon > 180`.
- Depth is bounded by `manifest.max_path_len`; a longer path returns null
  without a GET (never derive a key the manifest cannot list).
- Cache: manifest once; shards in an LRU of 8 (≈1.6 MiB). Content-addressed, so
  a cached shard stays valid across manifest updates.
- Errors: `ManifestUnavailable`, `ShardMissing` (render the parent and say
  detail is unavailable), `ShardInvalid` (hard error, no partial render).

### 8.5 Source selection

`VITE_OFFLINE_MODE=1` → `FixtureSource` (below); otherwise `ContractSource` with
the committed manifest key. A `VITE_REGIONS_MANIFEST` override is for local
experiments only and must be documented as such.

---

## 9. Picker UI

### 9.1 Entry point

A dialog `#region-dialog`, opened by `#region-open` in the Advanced surface
(first-run placement is P4). Follow the existing dialog pattern
(`contacts-dialog.ts`): focus trap, `Esc`, return focus, `aria-labelledby`.

### 9.2 Map

- Leaflet with `L.CRS.EPSG4326`; **no tile layer**.
- `world-atlas` `countries-110m.json`, converted with `topojson-client`; vendor
  the JSON into `ui/src/assets/countries-110m.json` (commit it, record the
  Natural Earth provenance and public-domain status) so the build never
  downloads.
- `L.geoJSON` for countries; `L.rectangle` for the selected cell and its
  children; a label per child digit (`a`–`h`).
- Click: `map.on("click", e => resolve(e.latlng))`; also accept the coordinate
  form.
- Antimeridian: no cell crosses ±180 in this dataset (the world is split at
  0/180), but normalize clicks anyway.
- Fit bounds to the selected cell on resolution; keep a "world" reset.
- Call `map.invalidateSize()` after the dialog opens and before the first
  `fitBounds`, or a map created while hidden renders at the wrong size.

### 9.3 Result panel

- Path as letters (`aacbd`), plus the octal address (`00213`) for comparison
  with the zone UI.
- Depth, bounds, population (the cell's own value; never sum rows), and a table
  of the eight published children with digit, path, population.
- If a child is absent from the dataset, list it as "not published" (not
  "empty").
- `aria-live="polite"` announcements; the coordinate form is the keyboard path.
- Loading and error states: manifest unavailable, shard missing, verification
  failed. Never show a partial cell silently.

### 9.4 Bundle

Measured: the lazy picker chunk is **273.5 kB raw / 88.25 kB gzip JS** and
**15.6 kB / 6.5 kB gzip CSS** (Leaflet, `topojson-client`, vendored
countries-110m, and the dataset client). The main bundle grows by ~0.9 kB gzip
(trigger + dynamic import). No CDN, no tile server, no API key.

---

## 10. Constants and configuration

```ts
// ui/src/region/constants.ts
export const REGIONS_MANIFEST_KEY = "<base58, committed after first publish>";
export const REGIONS_STAGE_NOTE = "detail to level 7";
```

The manifest key is derived from the manifest WASM hash + parameters, so it is
stable across `seq` updates. A change to the manifest WASM or the publisher key
is a new key and a UI constant update.

---

## 11. Tests

### Rust

- Contract suites from §3 and §4.
- `wire`: encode/decode round-trip; golden bytes for a 3-row fixture; packed
  path property tests (random digits, 1–32, MSB-first).
- `tool`: packer properties on synthetic trees (contiguous, complete, sizes,
  determinism); a golden export over a 12-row fixture DB compared byte-for-byte
  against `fixtures/regions/{manifest.bin,shard.bin,expected.json}`.

### TypeScript

- `paths.test.ts`: pack/unpack parity with the Rust golden; compare/prefix.
- `wire.test.ts`: parse the **cross-language golden** in
  `fixtures/regions/{manifest.bin,shard.bin}` (produced and byte-checked by the
  tool test); reject truncation, wrong magic, unsorted rows, out-of-range
  bounds, hash mismatch.
- `geo.test.ts`: point→cell on a synthetic 3-level world; boundary points land
  in exactly one child; antimeridian normalization; poles.
- `dataset.test.ts`: lookup by path, children, LRU behavior, error mapping.

### Playwright (offline)

- Open Advanced → "Find your region"; the map renders countries.
- Click a known coordinate in the fixture → expected `aacb`-style path.
- Type coordinates in the form → same result.
- Assert **no request leaves the page** (route interception fails the test on an
  external URL).
- Axe: no new violations in the dialog.

### Live smoke (optional, manual)

With the published manifest: open the dialog, click, confirm the path from a
second node, repeat with a cold cache and count the GETs (manifest plus at most
three shards).

---

## 12. Acceptance checklist

- [ ] `make regions-wasm` builds both contracts; wasm hashes recorded.
- [ ] `make regions-export` reproduces §0's row/byte/shard numbers exactly.
- [ ] All 178 shards and the manifest verify from a second node.
- [ ] The manifest key is committed; a fresh browser session resolves a click
      with the manifest plus at most three shard GETs, and at most two once the
      manifest is cached.
- [ ] Offline e2e passes with zero external requests.
- [ ] No database, shard, or key file is tracked (`git status` clean; the
      `.gitignore` rules already cover them).
- [ ] `make check` includes the new Rust and tool tests.

---

## 13. Risks and open items

| Risk | Mitigation |
| --- | --- |
| `fdev publish` flakiness across 178 PUTs | ledger + resume; verify each shard; workers ≤ 3 |
| Key handling | seed only from env/path outside the repo; print the verifying key; never write it |
| Full-stage exporter memory | P1 indexes the truncated tree; the full stage will stream per depth-4 subtree (future work) |
| Cross-language drift | committed golden files produced by the Rust tool and parsed by TS |
| Formatting moves the hash | panic-location strings embed source line numbers, so `cargo fmt` after recording a hash changes it | run `cargo fmt --check` (in `regions-check`) before recording; rebuild and re-record |
| Packaged placeholder state | `fdev build` bundles a 1-byte state | resolved 2026-11-07: `publish --state` overrides it (live fixture on 7509) |
| Leaflet/CSP | all assets bundled; countries vendored; the e2e test fails on external requests |
| Antimeridian/wrap | normalize clicks; the dataset's cells do not cross ±180 |
| Dataset availability | keep the publisher node online and subscribed to the manifest (§9.3 of `DESIGN-regions.md`) |

Open:

1. Provenance and licence text for the vendored `countries-110m.json`
   (Natural Earth; public domain) — where to show the attribution.
2. Path display: letters only, or letters + octal address (recommended: both).
3. Whether the picker's first-run placement lands in this phase or in P4.
4. Who holds the publisher seed for the first stage, and where the offline
   backup lives.
