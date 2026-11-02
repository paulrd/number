# Region dataset on Freenet — sharding and publishing design

Status: proposed, 2026-11-02. Source: `trie.db` (SQLite, ~13 GB, table
`region`). This document covers the dataset only; it does not change the zone
contract, delegate, or existing wire formats.

Revision note: population is included as a `u32`; the shard target is fixed at
**256 KiB**; the desired region picker is **Leaflet + `world-atlas`
`countries-110m`, no tile layer**.

## 1. What the data actually is

Measured from `trie.db`:

| Property | Value |
| --- | --- |
| Rows | **74,179,600** |
| Key | `region.materialized_path`, unique, alphabet `a`–`h` |
| Path length | 1–17 digits (most rows are depth 9–11) |
| Columns worth keeping | `materialized_path`, `min_lon`, `max_lon`, `min_lat`, `max_lat`, `population` |
| Columns dropped | `id`, `binary_path`, and the `geo_index` R-tree |
| Coordinate precision | every bound is an exact multiple of `2^-20` (verified for all rows) |
| Population encoding | `u32`, whole people, rounded from the source’s fractional estimate |
| Packed row size | `1 + ceil(3 * len(path) / 8) + 16 + 4` bytes |
| **Packed dataset** | **1,875,087,162 bytes (~1.75 GiB)** |

`materialized_path` is a trie address: a row is the parent of `path + digit` for
digits `a`–`h` (octal `0`–`7`). Lexicographic order of the `a`–`h` strings is
the trie's preorder, and every descendant of a path is a contiguous range
immediately after it. That is the property the sharding relies on.

Paths, bounds and population are stored. Population is a `u32` of whole people,
rounded from the source's fractional estimate; the source maximum is
2,144,729,716, comfortably inside `u32`. The `u32` choice adds only 4 bytes per
row and keeps the total population (72.8B) inside JavaScript's safe integer
range, so the UI can sum it without `BigInt`. If a future dataset needs
fractional values or a row above 4,294,967,295, that is a new row format
(`region-v3`) with a wider field, and every shard hash changes.

## 2. Why not one contract per region (or per trie node)

A contract per region would be **74,179,600 contracts**:

- 74M PUTs, each with its own network and validation overhead.
- A per-node contract with child pointers would store up to 8 × 32-byte child
  ids (~256 bytes) to describe a row that is typically ~25 bytes — metadata
  several times larger than the data.
- Freenet contract state is replicated and validated; 74M tiny contracts is a
  denial-of-service on the network's metadata budget, not a database.

A deep index tree is not needed either. At the recommended shard size the whole
shard index is a few hundred kilobytes (table below), so one manifest contract
is smaller and faster than several levels of index contracts: a read is one
manifest GET (amortised/cached) plus one shard GET, instead of 3–5 tiny GETs
whose latency dominates. Build a hierarchical manifest only if the manifest
outgrows ~4 MB, which is ~90,000 shards — far beyond this dataset.

## 3. Recommended architecture

```
                       signed, mutable manifest (small)
                       ┌──────────────────────────────┐
                       │ dataset id, format, code hash│
                       │ shard ranges + content hashes│
                       └──────────────┬───────────────┘
                                      │ start-path ranges
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
  shard 000 (immutable)         shard 001 (immutable)         shard N-1
  content hash in params        content hash in params        content hash in params
  rows [start, next_start)      rows [start, next_start)      rows [start, ∞)
```

Two contract WASMs, one family:

1. **Shard contract** — a generic immutable blob. Parameters contain the
   BLAKE3 hash of the state. `validate_state` recomputes the hash, so the
   contract id and the bytes are bound together. Shards need no publisher
   signature and can be re-published idempotently by anyone.
2. **Manifest contract** — a generic publisher-signed last-writer-wins
   register. Parameters contain the publisher's Ed25519 verifying key and a
   namespace. The payload lists shard ranges and hashes. Only the publisher can
   advance it.

This split gives the dataset the right trust model:

- The publisher key is needed only for the small manifest. It is not needed to
  serve or verify ~1.75 GiB of shards.
- A shard is self-verifying: `BLAKE3(state) == params.content_hash`. A peer
  cannot alter it without producing a different contract id.
- An update is: publish new/changed shards (new content hashes → new contract
  ids), then sign and publish `manifest.seq + 1`. Old shards remain readable
  under the old manifest; readers cut over when they see the new manifest.
- Unchanged shards keep the same hash and contract id, so an update only
  re-uploads the changed ranges.

## 4. Shard size and boundaries

Shards are **contiguous ranges of `materialized_path`**, aligned to trie
subtrees, with a target serialized size. They are not hash shards: hashing would
destroy the descendant locality that lets a zone read itself and its children
from one or two shards.

Measured with population included, running the boundary algorithm below over
the real tree (not a `total / target` estimate — subtree alignment leaves some
shards under-filled):

| Target | Shards | Manifest (~46 B/entry) | Avg shard | Max shard |
| --- | ---: | ---: | ---: | ---: |
| 4 MiB | 603 | ~27 KiB | 3.0 MiB | 4.0 MiB |
| 1 MiB | 2,409 | ~108 KiB | 760 KiB | 1.0 MiB |
| **256 KiB** | **9,511** | **~427 KiB** | **193 KiB** | **256 KiB** |

**Decision: 256 KiB.** It is the best balance for this app:

- each contract averages **193 KiB**, far below the 4 MiB design target and the
  50 MiB hard cap;
- the manifest is **~427 KiB**, well under 1 MiB and far below the 4 MiB point
  where a hierarchical manifest becomes necessary;
- a zone lookup fetches ~**7,800 rows**, rather than ~30,800 at 1 MiB or
  ~123,000 at 4 MiB;
- **9,511 contracts** is large but publishable, and far below the 74M contracts
  of a per-region design;
- the whole packed dataset is **1.75 GiB**, and unchanged shards keep their
  content hash across updates.

The documented alternatives are 1 MiB (2,409 contracts, 108 KiB manifest, but
~1 MiB per zone GET) and 4 MiB (603 contracts, 27 KiB manifest, but ~3 MiB per
zone GET). The format and manifest do not change with the target — only the
boundaries do. The 256 KiB decision is revisited only if publishing 9,511
contracts proves operationally painful; per-zone read cost is the reason not to
go larger.

### Boundary algorithm

Build shards bottom-up over the trie, not by a fixed depth and not by a naive
row counter:

1. For each node, compute `subtree_bytes` = bytes of its row plus all
   descendants. Lexicographic order is preorder. One forward streaming pass with
   a stack does it: push a frame per row; when the next path is not a descendant
   of the top frame, pop it, finalize its subtree total, and add that total to
   its parent. Stack depth is the path depth (≤17), not the row count, so memory
   is `O(depth)`; the work is `O(rows × depth)` prefix comparisons.
2. Recursively:
   - if `subtree_bytes(node) <= target`, make the whole subtree one shard;
   - otherwise, process its children in digit order, recursively splitting any
     child that is itself larger than the target, and pack consecutive child
     shards into bundles up to `target`.
3. A shard's range is `[first_path_in_shard, next_shard_first_path)`. The last
   shard has no upper bound. Store only each shard's **start path** in the
   manifest; the next start defines the end.

This never splits a subtree that fits, so a zone's row and its descendants stay
together when their subtree fits. It also makes boundaries stable across
dataset updates: a change inside a small subtree affects that shard, not every
later shard (which is what a flat row-count packer would do).

## 5. Contract designs

### 5.1 Shard contract: `region-blob`

Generic immutable blob; reusable for any content-addressed data.

**Parameters**

```
"RGB1"                         4 bytes magic
content_hash                  32 bytes BLAKE3 of state
                              = 36 bytes total
```

**State** — arbitrary bytes; the dataset payload is defined in §6. The contract
does not parse it, which keeps the contract stable across dataset format
changes.

**Interface**

- `validate_state`: check params magic/length, `state.len() <= MAX_BLOB_BYTES`
  (use 8 MiB), and `BLAKE3(state) == content_hash`. Return `Valid`/`Invalid`.
- `update_state`: the only admissible state is the one whose hash matches, so
  accept an identical incoming state as a no-op and return
  `ContractError::InvalidUpdate` for anything else. This is a legal immutable
  contract: no update can change it.
- `summarize_state`: the 32-byte content hash. This is far smaller than the
  state and is exactly what the delta comparison needs.
- `get_state_delta`: if `summary == content_hash`, return an empty
  `StateDelta`; otherwise return the full state (the only state this contract
  can have).
- Merge law: the set of admissible states is a singleton, so the merge is
  associative, commutative and idempotent.

### 5.2 Manifest contract: `region-manifest`

Generic publisher-owned signed blob with a monotonic sequence number. It can
hold any publisher-authored payload; the dataset format lives in the payload.

**Parameters**

```
"MGB1"                         4 bytes magic
publisher_verifying_key       32 bytes Ed25519
namespace                     16 bytes BLAKE3("number:regions")[..16]
                              = 52 bytes total
```

**State**

```
seq                           8 bytes little-endian, > 0
payload_len                   4 bytes little-endian
payload                       payload_len bytes
signature                     64 bytes Ed25519
```

Signature domain: `"number:region-manifest:v1" || params || seq || payload`.
The domain and params bind the signature to this contract family and prevent a
manifest signed for another publisher/namespace from being replayed.

**Interface**

- `validate_state`: check params, bounds (`payload_len <= 4 MiB`, `seq > 0`),
  and the signature. Return `Valid`/`Invalid`.
- `update_state`: decode and validate every incoming `UpdateData::State` (the
  host does not promise that incoming updates were pre-validated), then keep the
  state with the greatest `(seq, BLAKE3(full_state_bytes))`. Tie-breaking on the
  **full state hash**, not the payload hash, matters: two valid signatures over
  the same payload would otherwise tie and leave peers holding different bytes
  forever (their summaries would match, so neither would ever heal). The full
  state hash makes the order total and deterministic. Lower `seq` never wins.
  Return `UpdateModification::valid(chosen)`.
- `summarize_state`: `seq (8) || BLAKE3(full_state_bytes) (32)` = 40 bytes.
- `get_state_delta`: parse the summary's `(seq, state_hash)` and compare it
  to the current state's key. If the summary key is greater than or equal to
  ours, return empty — we have nothing newer to add, and an older peer must not
  be sent a downgrade. Otherwise return the full state. An up-to-date peer gets
  zero bytes.
- Merge law: max over a total order → associative, commutative, idempotent.
  Only the publisher can create a signed candidate, so strangers cannot spam
  the register.

### 5.3 Contract ids and UI constants

Freenet id: `BLAKE3(BLAKE3(wasm) || params)`.

- Manifest id: derived from the manifest code hash + the 52-byte params above.
  Commit it in the UI's constants (or a small generated file) next to the
  existing contract/delegate constants.
- Shard id: derived from the entry's code hash (from the manifest's code-hash
  table) plus `"RGB1" || content_hash`. The manifest therefore lets a client
  derive every shard id without storing thousands of ids.
- The manifest carries a **table of shard code hashes** and each entry selects
  one. A shard-WASM upgrade can add a new generation without republishing
  unchanged shards from the old generation; old clients and new clients can
  both resolve every listed entry. Freeze the shard WASM where possible — the
  code-hash table is the escape hatch, not a reason to churn it.
- If the **manifest** WASM is upgraded, its own contract id moves. Keep a small
  legacy-manifest-id list in `ui/src/migrations.ts`-style code only if a cutover
  needs old clients to keep working; the old manifest contract and all shards it
  names remain readable. A read-only dataset needs a cutover, not a state
  migration.

## 6. Wire formats

### 6.1 Shard payload (format `region-v2`)

```
magic                4 bytes  "RGN1"
format_version       1 byte   2
row_count            4 bytes  little-endian
rows                 row_count × Row, sorted by path
```

`Row`:

```
path_len             1 byte    1..=32
path_packed          ceil(3 * path_len / 8) bytes
min_lon, max_lon,
min_lat, max_lat     4 × i32 little-endian
population           1 × u32 little-endian
```

`population` is whole people, rounded from the source estimate; `0` is valid.
The current maximum (2,144,729,716) fits `u32`. A value that does not fit, or a
need for fractional population, is a `region-v3` format with a wider field —
never a silent clamp. With population, a row is
`1 + ceil(3 * len(path) / 8) + 16 + 4` bytes (21 bytes plus the packed path).

Path digits are `0`–`7` (the dataset's `a`–`h` mapped to `0`–`7`), packed three
bits per digit, most-significant bit first. A path is compared digit by digit;
a shorter path that is a prefix of a longer one sorts first.

Coordinates are signed fixed point with scale **2^22**:

```
encoded = round(value * 2^22)      // i32
value   = encoded / 2^22
```

2^22 covers every coordinate in the current data exactly (they are multiples of
2^-20, verified for all 74,179,600 rows), stays inside i32
(`180 * 2^22 = 754,974,720`), and leaves headroom for a deeper future trie.
2^20 would also work; 2^22 costs nothing and is the recommended constant.

### 6.2 Manifest payload (format `region-manifest-v1`)

```
magic                4 bytes  "RGM1"
format_version       1 byte   1
dataset_id           16 bytes
row_format           1 byte   2 (region-v2, includes population)
code_hash_count      1 byte
code_hashes          code_hash_count × 32 bytes BLAKE3(shard wasm)
total_rows           8 bytes  little-endian
max_path_len         1 byte
shard_count          4 bytes  little-endian
entries              shard_count × Entry, sorted by start path
```

`Entry`:

```
start_len            1 byte
start_packed         ceil(3 * start_len / 8) bytes
code_hash_id         1 byte   index into code_hashes
rows                 4 bytes  little-endian
bytes                4 bytes  little-endian
content_hash         32 bytes
```

Entry `i` covers `[start_i, start_{i+1})`; the last entry covers
`[start_last, ∞)`. The client:

1. binary-searches for the greatest `start_i <= path`;
2. derives the shard id from `code_hashes[entry.code_hash_id]` and
   `entry.content_hash`;
3. GETs that shard and parses it;
4. verifies `BLAKE3(state) == content_hash`, magic, `format_version == 2`, row
   count, sorted paths, `rows[0].path == start_i`, every path in the entry's
   range, coordinate bounds, and the population field;
5. looks up the exact path (linear scan is fine at ≤256 KiB; add a sparse
   every-256-row offset table only if profiling shows a need).

`total_rows` and the sum of `rows` must agree; the generator asserts this before
signing. A missing path is a normal "not a region" result: do not GET a
derived key that the manifest does not list. That is the slowest read on
Freenet.

## 7. Read path for a zone contact

A zone at octal address `p` (the app's existing derived address) needs the row
for `p`, and usually the rows for `p + "0"` … `p + "7"` (its child slots):

1. Fetch and cache the manifest once per session (subscribe if updates are
   expected; the summary is 40 bytes).
2. For the set `{p, p0..p7}`, map each path to a manifest entry, deduplicate the
   shard ids, and GET each needed shard concurrently.
3. Parse each shard once, index rows by path, and answer all nine lookups. Each
   `RegionRow` now carries `population` (`u32`, whole people) alongside the four
   bounds; display it with the region, or use it for ranking.
4. If a child path is absent, it is not in the dataset; do not probe further.

Because descendants are contiguous, the zone and most of its children land in
one shard; only a split at a large child subtree adds a second GET. A parent
contract's name/label remains in the zone contract; the region row is reference
data and is not written into zone state.

One convention must hold for the lookup to mean anything: **a zone's slot index
must be the same child digit as the dataset's `a`–`h` child order**. The shard
format cannot enforce that, because the zone's slot index is user-assigned. If
slots are assigned by geography instead, translate through the dataset's child
order before forming the address to look up.

## 8. Region picker visualization (desired)

The app should let a user find the region/zone they belong to by selecting a
point on a world map. This is a **shared vector viewport**, not stored imagery.

**Desired implementation:** **Leaflet** with the **`world-atlas`
`countries-110m.json`** geometry and **no tile layer**. Bundle the library, CSS
and TopoJSON/GeoJSON in the UI (or a small asset contract). Leaflet supplies
zoom/pan, `L.rectangle` for region bounds and `map.on("click", e => e.latlng)`
for point selection.

Why this choice:

- ~50 KiB gzipped Leaflet JS/CSS plus ~30–100 KiB compressed country geometry;
  negligible next to the portal and game bundles.
- No external tile server, CDN, API key or network attribution request; the
  gateway CSP blocks external tiles anyway.
- The map is shared by every region/zone: one basemap, not 74M per-region
  images.
- `countries-110m` is enough context for picking a position. Use
  `countries-50m` only if more coastline detail is needed.
- Rectangles remain numeric: each region's lon/lat bbox is an `L.rectangle`;
  no per-region graphic is stored.

Interaction:

1. Render the country geometry as a GeoJSON layer on an `L.map` with no
   `L.tileLayer`.
2. Overlay the active zone and its eight children as rectangles (optionally a
   coarse world layer at depth ≤4, 3,616 rectangles).
3. On click, read `e.latlng` (lon/lat).
4. Find the containing region by descending the region trie: at each node,
   choose the child whose bbox contains the point; if no child does, the
   current node is the region. This is exact and uses the numeric dataset.
5. Resolve that region path to the zone/contact the user belongs to using the
   app's existing parent/child and contact lookup.

**Projection:** default Leaflet EPSG:3857 clips at ±85.05°, so use
`L.CRS.EPSG4326` (or D3 equirectangular) if the polar rows matter. A lon/lat
bbox is axis-aligned in both EPSG:3857 and EPSG:4326.

**Scale:** draw the selected zone and its children plus at most a coarse
overview; do not draw all 74M rows. Fetch only the shards for the current
subtree or viewport.

**Fallback:** if Leaflet is too heavy or full drawing control is needed, the
same design works with `d3-geo` + `d3-zoom` on Canvas at a smaller bundle. The
data source and click-to-region algorithm are unchanged. `world-atlas` derives
from Natural Earth; retain the required attribution/licence notice.

## 9. Generation and publishing pipeline

### 9.1 Export (offline, read-only)

Use `sqlite3` read-only (`file:trie.db?mode=ro`, `PRAGMA query_only=ON`) inside
one read transaction (or against a snapshot copy) so both passes see the same
rows even if the source is being regenerated. The existing unique index on
`materialized_path` supplies the order; ignore `geo_index`.

1. Pass 1: stream `SELECT materialized_path FROM region ORDER BY
   materialized_path`; a forward stack pass computes `subtree_bytes` and emits
   shard boundaries (§4). Population contributes a fixed 4 bytes per row, so
   paths and lengths are still enough for the boundary pass.
2. Pass 2: stream `SELECT materialized_path, min_lon, max_lon, min_lat, max_lat,
   population FROM region ORDER BY materialized_path`; encode rows and write
   one file per shard according to the boundaries.
3. Write `manifest.bin` with each shard's start, row count, byte count and
   BLAKE3 hash. Sign nothing here; the signing step is separate and needs the
   publisher key.
4. Assert: row count 74,179,600; every coordinate quantizes exactly; every
   population is finite, non-negative and fits `u32` after rounding; shard
   sizes ≤ target (except a single row larger than a tiny target); ranges are
   contiguous and non-overlapping; the sum of shard rows equals `total_rows`;
   the packed total is 1,875,087,162 bytes for this source.

Default output: `.build/regions/` (already ignored). Never write shards or a
database copy anywhere tracked by git.

### 9.2 Publish (network)

Publish shards first, manifest last, so no reader ever sees an index entry for a
contract that was not published:

```bash
fdev --port 7510 publish \
  --code .build/regions/region_blob.wasm \
  --parameters .build/regions/params/000123.bin \
  contract \
  --state .build/regions/shards/000123.bin
```

- Derive and verify the contract id locally before each PUT.
- Use a bounded worker pool (2–4) against one node; too much concurrency causes
  queue pressure. `--timeout` should be generous for multi-hundred-KiB states.
- Keep a resumable ledger (`published.jsonl` with id, hash, status) under the
  ignored output directory. A rerun skips `ok` entries; a re-PUT of an existing
  content-addressed shard is idempotent.
- Publish/sign the manifest only after every shard in it has been accepted.
- For a first publish, verify a random sample (and optionally all shards) from a
  second node: GET, hash, parse, compare a few rows to SQLite.

### 9.3 Availability

Freenet storage is demand-driven, not a permanent archive. Keep the publisher's
node online as a seed and consider `--subscribe` for the manifest (tiny) and the
most-used shards; re-publish cold shards if they are evicted. Content-addressing
makes re-publishing safe and deduplicating. State this expectation in the app's
docs: the dataset is available while interested peers hold it, not guaranteed
forever by the network.

## 10. Updates and versioning

- **Shard bytes are immutable.** A change produces a new content hash and a new
  contract id. Unchanged shards keep their ids, so an update only re-uploads the
  affected ranges.
- **Manifest is the version pointer.** Publish a new signed payload with
  `seq + 1` after the new shards are live. Readers with the old manifest keep
  reading old shards; subscribers cut over when the new manifest arrives.
- **Do not change `row_format` in place.** Add a new format version or a new
  field with a version bump; old clients ignore unknown manifest versions.
- **Population is part of `region-v2` as a `u32`.** Changing its width or
  precision (for example to `u64` or a fractional value) is a new row format
  and changes every shard hash. Do not silently clamp an out-of-range value;
  fail the export and bump the format.

## 11. Repository hygiene

Database files and generated shards must never be committed. `.gitignore`
covers:

```
trie.db
trie.db-*
*.db
*.db-*
*.sqlite
*.sqlite3
/regions/
/data/
```

The source `trie.db` and its `-shm`/`-wal` are already ignored; the broader
patterns cover copies, scratch databases and user-specified export directories.
The default export path `.build/regions/` is already ignored via `.build`.
Before publishing, check:

```bash
git status --porcelain          # must not mention .db / regions/
git check-ignore -v trie.db trie.db-wal .build/regions/shard.bin
```

Generated manifests, shard files, ledgers and signing keys stay outside the
repo. The signing key is never written by the tooling; read it from a path
outside the repository or an environment variable.

## 12. Decisions and open items

Settled:

- **Shard target: 256 KiB.** Measured with population: 9,511 shards, ~427 KiB
  manifest, 193 KiB average shard, ~7,800 rows per zone lookup. See §4.
- **Population: `u32` whole people.** Rounded from the source estimate; the
  current maximum fits. See §1 and §6.1.
- **Visualization: Leaflet + `world-atlas` `countries-110m`, no tile layer.**
  A shared vector basemap for click-to-region selection. See §8.

Open:

1. **Implement now?** The next deliverable is the exporter + manifest signer +
   resumable publisher, with the two small contract crates. No network publish
   until the generated manifest and a local dry run are verified.
2. **Population precision.** `u32` is chosen. If exact fractional population or
   a row above `u32` is ever required, define `region-v3` with a wider field and
   republish all shards.
3. **Hierarchical manifest.** Not needed at this scale. Revisit only if the
   shard count approaches ~90,000 (manifest >4 MB).
