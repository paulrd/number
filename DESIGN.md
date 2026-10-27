# number — design (v1)

A personal Freenet app: one board per user, holding exactly **8 slots**. Each
slot is either empty or holds an **i64** value with optional `label`, `unit`,
and `note`. Only the board's owner can write. The board is a contract instance
parameterised by the owner's Ed25519 verifying key, so the owner's identity is
the stable anchor (a new WASM version re-keys the instance, but the client
re-derives it from the same owner key).

Components:

- `contract/` — `number-contract` WASM (shared state, validation, merge).
- `delegate/` — `number-delegate` WASM (private key custody + signing).
- `ui/` — TypeScript + Vite frontend (WebSocket client, owner of the UX).

The contract never reads the host clock and never uses randomness inside
`validate_state` / `update_state` / `summarize_state` / `get_state_delta`.

---

## 1. Contract parameters

`parameters` = the raw 32 bytes of the owner's Ed25519 **verifying key**. No
serde wrapper, no length prefix, no domain tag. `validate_state` rejects any
parameter blob whose length is not exactly 32.

Contract code hash: `code_hash = BLAKE3(wasm bytes)`.
Instance id: `BLAKE3(code_hash_bytes || parameters)` (exactly as
`freenet_stdlib::ContractKey::generate_id`).

## 2. Contract state (JSON, UTF-8)

```json
{
  "v": 1,
  "slots": [
    { "seq": 0, "entry": null, "sig": null },
    { "seq": 3, "entry": { "value": -42, "label": "weight", "unit": "kg", "note": null }, "sig": "<128 lowercase hex chars>" }
  ]
}
```

Rules:

- `slots` is **exactly 8** entries; index = slot number `0..7`.
- `seq == 0` ⇒ `entry == null` and `sig == null` (initial/empty slot).
- `seq > 0` ⇒ `sig` is a valid Ed25519 signature over the signing bytes below.
  `entry == null` with `seq > 0` is a **tombstone** (slot cleared) and is legal.
- `value` is an i64 JSON number. The UI additionally warns when a value is
  outside `Number.MAX_SAFE_INTEGER`.
- Bounds (bytes, UTF-8): `label` ≤ 64, `unit` ≤ 16, `note` ≤ 512. `null` and
  absent are equivalent for the optional strings; serialise `null`.
- `v` must be `1`.

### Signing bytes (canonical, hand-built)

```
b"number:v1:slot"
|| slot_index: u8
|| seq: u64 little-endian
|| entry_tag: u8            // 0 = None, 1 = Some
// only when entry_tag == 1:
|| value: i64 little-endian
|| label_len: u32 LE || label bytes
|| unit_len:  u32 LE || unit bytes
|| note_len:  u32 LE || note bytes
```

`None` optional strings encode as length `0` (there is no null/absent
distinction on the wire). The signature covers the slot index, the seq, and
every field of the entry. Both the contract and the delegate MUST build these
bytes with the same function shape. A golden vector in each crate's tests pins
it.

## 3. Summary (JSON, UTF-8)

```json
{ "v": 1, "slots": [ [3, "<32 hex chars>"], [0, "00000000000000000000000000000000"] ] }
```

Exactly 8 pairs: `[seq, digest16]`. `digest16` is the first 16 bytes of
`BLAKE3(signing bytes for that slot)` for `seq > 0`, and 16 zero bytes for an
empty slot. The digest exists so two peers that hold the same `seq` but
different entries (owner equivocation) still notice and heal. Every summary
field is read by `get_state_delta`.

## 4. Delta (JSON, UTF-8)

```json
{ "v": 1, "slots": [ { "i": 2, "seq": 4, "entry": null, "sig": "<hex>" } ] }
```

`get_state_delta` includes slot `i` iff

```
our.seq > their.seq
|| (our.seq == their.seq && our.digest16 != their.digest16)
```

If no slot qualifies, return a literally empty `StateDelta::from(vec![])`.

## 5. Merge rule (per slot)

Merge is `max` over the total order:

1. higher `seq` wins;
2. equal `seq` → the slot whose **signature bytes** are lexicographically
   greater wins;
3. equal `seq` and equal signature → identical slot.

Properties: associative, commutative, idempotent, absorbing. A full-state
update is merged slot-wise; a delta is merged slot-wise; re-applying either is a
no-op.

Invalid input is **rejected atomically** for state/delta (single writer →
atomic is correct): any slot with a bad signature, out-of-bounds metadata, or
`seq == 0` with a non-null entry rejects the whole update. Stale (lower-seq)
slots are not an error — they lose the merge.

## 6. ContractInterface behaviour

- `validate_state(parameters, state, related)`:
  - params length 32 and a valid Ed25519 point;
  - state decodes as a valid `StateV1` per §2, exactly 8 slots;
  - every `seq > 0` slot's signature verifies under the params key.
- `update_state(parameters, state, data)`:
  - decode current state; for each `UpdateData::State` / `Delta` /
    `StateAndDelta`, validate the incoming slots, then merge per §5;
  - `UpdateData::Related*` is not used (no related contracts);
  - return `UpdateModification::valid(merged_bytes)`.
- `summarize_state`: §3.
- `get_state_delta`: §4, empty bytes when converged.

No `freenet_stdlib::time::now()`, no `rand` inside contract functions.

## 7. Delegate protocol (`number-delegate`)

Application messages are JSON, UTF-8, in `ApplicationMessage.payload`.

Request:

```json
{ "cmd": "identity" }
{ "cmd": "sign", "slot": 3, "seq": 7, "entry": { "value": 12, "label": null, "unit": null, "note": null } }
{ "cmd": "sign", "slot": 3, "seq": 8, "entry": null }
```

Response (outbound `ApplicationMessage`):

```json
{ "ok": true, "pubkey": "<64 hex>", "nextSeq": [1,1,1,1,1,1,1,1] }   // identity
{ "ok": true, "sig": "<128 hex>" }                                   // sign
{ "ok": false, "error": "..." }                                      // any failure
```

Secrets (delegate secret store):

- `number.v1.seed` — 32-byte Ed25519 seed, generated with
  `freenet_stdlib::rand::rand_bytes(32)` on first use.
- `number.v1.nextseq.<i>` — 8-byte little-endian u64, per slot, default 1.

Rules:

- `slot` must be `0..7`; `seq >= nextseq[slot]`; `seq > 0`.
- Enforce the §2 metadata bounds; sign §2 canonical bytes; then store
  `nextseq[slot] = seq + 1`.
- Only accept messages whose `origin` is `Some(MessageOrigin::WebApp(_))`;
  reject everything else.
- Core signing/storage logic must be testable without a host, e.g. a
  `sign_with(store: &mut impl SecretStore, ..)` seam (see delegate-patterns →
  "Take `impl SecretStore`").

## 8. UI flow

1. Connect `FreenetWsApi` to `${ws(s)}://${location.host}/v1/contract/command`
   with `base: "./"` assets and empty auth token.
2. Ask the delegate for `identity` (delegate key + code hash injected at build).
3. `params = pubkey bytes`; `instance = blake3(code_hash_bytes || params)`;
   build `ContractKey(instance, code_hash_bytes)`.
4. `GET`; on not-found, `PUT` the bundled `number_contract.wasm` with params and
   an all-empty `initial_state` (mirror `buildShardPutRequest` from
   freenet-microblogging), then `SUBSCRIBE`.
5. Render 8 slots; an edit computes `seq = max(contract seq, nextSeq) + 1`? No:
   use `seq = max(contract.seq, delegate.nextSeq[i])` then ask the delegate to
   sign that `seq`; delegate stores `seq+1`. Contract merge then accepts it.
6. Send `UpdateRequest(key, DeltaUpdate(delta bytes))`; update UI from the
   response / subscription notification.
7. Clearing a slot sends `entry: null` with a higher `seq` (tombstone).

Build-time constants (Vite `define`):

- `__CONTRACT_CODE_HASH__` — base58 string (contract code hash)
- `__DELEGATE_KEY_BYTES__`, `__DELEGATE_CODE_HASH_BYTES__` — number arrays
- `__CONTRACT_WASM_URL__` — `./number_contract.wasm`

## 9. Layout and ownership

```
contract/     # standalone crate, own Cargo.lock (NOT a workspace member)
delegate/     # standalone crate, own Cargo.lock
ui/           # Vite app
scripts/      # build/publish helpers
Makefile
```

Contract and delegate are excluded from any workspace (see build-system →
"Per-contract lockfile isolation"). Their `Cargo.toml` pins are exact.

## 10. Acceptance

- `cargo test` in `contract/` covers: signature tamper per field, bounds,
  seq-0 invariant, merkle-free summary/delta round-trip, empty delta when
  converged, property tests for merge comm/assoc/idempotence/absorption.
- `cargo test` in `delegate/` covers: identity creation/stability, sign golden
  vector, seq monotonicity, bounds, origin rejection.
- `fdev verify-merge` on generated corpus: no violations.
- `npm run build` in `ui/`, then Playwright smoke against `vite preview`
  (offline/mock mode) with a clean console.
- Local node: publish delegate + contract, PUT/UPDATE via the UI, reload and
  confirm persistence; tombstone a slot and confirm it does not resurrect.

## 11. Verified behaviours (local-node findings)

These are not design preferences; each was observed against `freenet` 0.2.150
(`freenet local`, WS API on 7510) and are load-bearing for the UI.

- **An empty summary means "I hold nothing".** The node presents an empty
  summary when a subscriber is first registered. `get_state_delta` therefore
  returns every non-empty slot for an empty (or undecodable) summary instead of
  rejecting it. Returning `InvalidDelta` there aborts the notification with
  `trying to read an invalid delta` in the node log, which silently kills live
  updates.
- **GET for a missing instance may time out rather than report not-found.**
  `freenet-stdlib` 0.4.0 delivers not-found through the `onContractNotFound`
  handler, not by rejecting `get()`, and the gateway's sandbox shim does not
  always forward it. The UI probes with a short budget (4 s); any failure is
  followed by a PUT. PUT over an existing instance is a merge no-op (the empty
  initial state loses every slot merge), so a spurious PUT only costs bandwidth.
- **`SubscribeResponse` is not always delivered through the shell shim.** A
  long-lived local test showed the subscribe promise timing out while deltas
  continued to arrive in a second browser. A timeout is therefore treated as
  "unconfirmed"; a real refusal arrives via `onSubscribeResponse(subscribed:
  false)` and is reported.
- **The board's contract key is stable per owner but moves with the contract
  WASM.** It is `BLAKE3(BLAKE3(wasm) || owner_pubkey)`. Any contract change
  (including a dependency bump) creates a new instance; the owner key remains
  the stable anchor for a future migration.
