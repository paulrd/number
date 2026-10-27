# Backlog and handoff

This file is the durable state for the project. Read it with `README.md` and
`DESIGN.md` before starting a fresh session.

## Current state

Local-only deployment; not published on the live Freenet network.

| Item | Value |
|---|---|
| Local node | `127.0.0.1:7510` (loopback-only) |
| Webapp id | `BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k` |
| Local URL | `http://127.0.0.1:7510/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Current delegate key | `3ViRVk2ScELVVmk4bjJVWS33dD6SiSmTbSQ1b8yDHVdZ` |
| Current delegate code hash | `7SMgeUTjfdkYtay446EVLruxSwukeYKTozHiPSxUeKDY` |
| Current contract code hash | `6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX` |
| Owner identity | `7193df714c57b79be0fb550f3150ccb0a23680dd2ccc305cef87a712c244e351` |
| Board contract id | `4JkW7tMySXeg4vzsFGcnEyXpq7NNjGBGd9eQmqRGgbsk` |
| Slot 1 | `7` (preserved by the #3 re-key migration) |
| Published artifacts | `published/manifest.json` (source of truth for the address) |

Website signing key: backed up in KeePass, synced across four devices. The
remaining accepted risks are a single logical KeePass database and a
time-limited Dropbox version history. One independent offline KeePass export is
still recommended.

## Done

### #1 — Pin the delegate to the webapp origin

- Delegate params are the 32 raw bytes of the web container contract id.
- Missing/malformed params fail closed.
- Only `MessageOrigin::WebApp(id)` whose id equals the params is accepted.
- UI sends `ApplicationMessages.params` on every delegate request; omitting
  them makes the node refuse with `parameters do not match the delegate key`.

### #2 — Back up the website signing key

- `~/.config/freenet/website-keys/number-local.toml` is mode `600`.
- Key is in KeePass on four synced devices.
- Fingerprint: `afb33101d4a47f6dcf2aeb5af70f62db186997c214755aa73fb8a681b968f943`.

### #3 — Reproducible WASM build gate

- `rust-toolchain.toml` pins rustc 1.98.0 with `wasm32-unknown-unknown`; CI
  mirrors it.
- `scripts/build.sh` is the single supported build: `cargo build --locked`,
  per-crate target dirs under `--target-dir` (default `.build/`), one frozen
  `--remap-path-prefix` namespace (`/cargo`, `/rustup`, `/build`), and a
  post-build scan that fails if a build-machine path survived. Sealed off from
  ambient `RUSTFLAGS` / `CARGO_ENCODED_RUSTFLAGS`.
- `published/` commits both WASMs and `manifest.json` (active hashes, delegate
  key, webapp id, generation history, toolchain). `make check-artifacts`
  rebuilds in a throwaway dir and byte-compares; the CI `reproducible` job runs
  it. `make record-artifacts` is the only way to change `published/`.
- Migration guard: `record-artifacts` refuses to supersede a generation missing
  from `ui/src/migrations.ts`, and `ui/src/migrations.test.ts` fails if any
  superseded generation in the manifest is unregistered or the committed bytes
  stop matching the recorded hashes. Runs in `make check` and CI's UI job.
- Consequence, verified locally: the old artifacts embedded the build machine's
  cargo registry paths, so excluding them re-keyed both components. Appended
  `3f15…` to `LEGACY_CONTRACT_CODE_HASHES`; `BPjm…` was already registered.
  Re-published the delegate (`3ViR…`) and updated the site in place. On reload
  the UI recovered identity `7193df71…` from the old delegate and migrated the
  board from `EgbC…` to `4JkW…`, preserving slot 0 = `7` / seq 1.
- Reproducibility proven locally: two throwaway target dirs, and cargo vs
  `fdev build`, all produced identical bytes (sha256
  `e6d59ce2…` contract, `2ec258f6…` delegate).

### #4 — Delegate and contract migration

Delegate protocol adds:

- `status` — reports `hasSeed` without creating a seed.
- `export` — returns the seed and `nextSeq`.
- `import` — restores a seed into a fresh delegate; refuses if a seed exists.

UI:

- `ui/src/migrations.ts` is the committed registry.
- On load, before `identity()`, the UI exports from registered predecessors and
  imports the first success.
- It skips the active delegate in the registry.
- Missing predecessor probes are suppressed as user-visible errors.
- Contract migration probes `LEGACY_CONTRACT_CODE_HASHES`, GETs old signed
  state, and PUTs it into the current contract before falling back to empty.

Verified end-to-end locally:

- Delegate v2 (`4BBh…`) → v4 (`BPjm…`) preserved identity, board key, and slot.
- Contract `7aK2…` → `3f15…` preserved identity and slot `7`.

### #7 — Make `verify-merge` meaningful

`--state`/`--transition` cannot supply deltas or summaries, so
`delta_idempotence` and `delta_permutation_invariance` generated **zero cases**
and `delta_determinism` only ever tested the self-summary. A law that silently
drops out is not a clean bill of health.

- `contract/examples/gen_corpus.rs` now writes a `ReplayBundle` (schema 1) with
  states, deltas, summaries and transitions. Deltas come from the contract's own
  `get_state_delta(sender, recipient_summary)`; every transition is re-applied
  (twice, for idempotence) before it is written, so the corpus cannot claim a
  step the contract does not take.
- Three concurrent updates share base `s2`, which is what makes
  `delta_permutation_invariance` a genuine same-base pair rather than a
  causally-sequenced one. A second base (`s3`) carries its own delta.
- The bundle struct mirrors `freenet::conformance::bundle::ReplayBundle` field
  for field. Bincode encodes fields in declaration order, so this needs no
  node-crate dependency; the schema-1 magic makes a core-side change a loud
  decode failure.
- `scripts/verify-merge.sh` (behind `make verify-merge`) asserts 0 violations,
  **0 inconclusive**, non-empty deltas/summaries, no code diagnostics, then runs
  each of the 14 laws alone and requires at least one case. That last step is
  what stops a law silently disappearing from the run.
- Result: 7 states, 5 deltas, 7 summaries, 5 transitions → 264 cases, 0
  violations, 0 inconclusive, 14/14 laws covered. WASM bytes unchanged, so no
  re-key (`make check-artifacts` still matches `published/`).

### #8 — Dev proxy

`npm run dev` could not reach a node: it talked to `:8080`, which has no `/v1`.

- `ui/dev-proxy.ts` plus `vite.config.ts`: a dev-only proxy for `/v1` (HTTP and
  WebSocket) to `FREENET_NODE_URL` (default `http://127.0.0.1:7510`).
- Auth: mint a token the way the gateway shell does — load
  `/v1/contract/web/<id>/` and read `freenetBridge("<token>")` — then send it as
  a Bearer header on the upgrade, which the node treats like `authToken`.
  `FREENET_AUTH_TOKEN` skips minting; `FREENET_WEBAPP_ID` overrides the pin.
- Disabled for `vite build`, unit tests, `vite preview` and offline mode, so
  none of those need a node. If minting fails the server still starts with a
  warning: contract reads work, delegate actions fail until the site is
  published or a token is supplied.
- Verified: `npm run dev` connects through the proxy, delegate attestation
  works, identity `7193df71…` and board `4JkW…` / slot 7 render with a clean
  console; `make e2e-offline` still runs with no node and no mint delay.
- Tokens are in-memory on the node, so restart the dev server after restarting
  the node.

### #5/#6 — Browser smoke and CI

- `ui/e2e/offline.spec.ts` — built UI + mock backend, save, axe, clean console.
- `ui/e2e/gateway.spec.ts` — gateway shell, iframe, identity, board readiness.
- `.github/workflows/ci.yml` — contract, delegate, UI, offline browser smoke,
  and `fdev verify-merge`.
- `make e2e-offline` and `make e2e-gateway`.

## Remaining

### #9 — Port consistency (next)

`make node` runs default `:7509`; README/local verification use `:7510`.
Make the port a variable and add an isolated target.

### #10 — Identity export/import for users

The seed lives only in the local delegate. Export/import across devices is not
exposed in the UI. This is user-facing portability, not automatic migration.

### #11 — Exact i64 beyond `Number.MAX_SAFE_INTEGER`

The UI rejects values it cannot represent exactly. Supporting the full i64
range needs a schema change (e.g. decimal string) and therefore a contract
re-key plus migration.

### #12 — Live-network deploy and Atlas submission

Only loopback has been exercised. Do not publish live until #3, #2, and the
migration guard are complete.

### #13 — Upstream shim report

The gateway shell shim drops `SubscribeResponse`/`NotFound`; the UI works around
it with probe-then-PUT and a timeout downgrade. Report a repro upstream.

## Generation history

- `8GpT86YKAZoQeFDzWQhNZwHv6C73JqaNxd5KE48NY1Z8` — first pinned delegate;
  predates `export`, permanently unrecoverable. Its board is abandoned.
- `4BBhEqP7m5aU3Z8UcDuWZ5ubc1jGZBSTwmxtSkca3SAE` — first export-capable
  delegate; registered as legacy. Code hash
  `FMjnDNpcFVEJs64iGffFXRktbQDF8f1HgGdDQZ4EHdKW`.
- `44uPSHVviSrNmtmLYVfudL6sVEptdEtrmMCBP6jebboH` — test-only intermediate
  from a failed first migration attempt; not registered. Its seed/board are
  abandoned.
- `BPjm4EX38ag6SJG7ABA1H494nWCxVXo1GRM7UzC74SVX` — previous, export-capable;
  registered. Code hash `7GQ6yxU9x7KKBKfGyTx5MJysQQJjbYj8WQsG6L42xedh`.
  Superseded by the #3 reproducible build; migrated its seed forward.
- `3ViRVk2ScELVVmk4bjJVWS33dD6SiSmTbSQ1b8yDHVdZ` — **current**, code hash
  `7SMgeUTjfdkYtay446EVLruxSwukeYKTozHiPSxUeKDY`, pinned to the webapp above.
  Recorded in `published/manifest.json`; append to `LEGACY_DELEGATES` before the
  next delegate change (the record gate enforces it).
- Contract `7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez` — old v1 hash,
  registered as legacy. Board `9UpJtiFg…`.
- Contract `3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd` — pre-remap build,
  registered as legacy. Board `EgbCX4Csk7nmA4cNB7CGQ4sxLKwtJPjjcEF1HntpgZkF`.
- Contract `6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX` — **current**,
  reproducible. Board `4JkW7tMySXeg4vzsFGcnEyXpq7NNjGBGd9eQmqRGgbsk`. Recorded
  in `published/manifest.json`; append to `LEGACY_CONTRACT_CODE_HASHES` before
  the next contract change.

## Rules that must not be broken

- `published/` is the deployed address. Change it only with
  `make record-artifacts`, and only after the outgoing generation is in
  `ui/src/migrations.ts`; `make check-artifacts` must pass.
- Before changing contract WASM, append the outgoing hash to
  `LEGACY_CONTRACT_CODE_HASHES`.
- Before changing delegate WASM, append the outgoing key, code hash, and webapp
  id to `LEGACY_DELEGATES`.
- Never remove a migration registry entry.
- The build remap namespace (`/cargo`, `/rustup`, `/build`) is frozen: changing
  a replacement root re-keys everything.
- A predecessor pinned to a different webapp id cannot be called from the new
  UI; migrate before changing the webapp id.
- Delegates and contracts are content-addressed: any WASM change re-keys them.
- The owner public key is the stable anchor; the contract id moves with the
  contract WASM.

## Verify

```bash
make check
make check-artifacts
make e2e-offline
FREENET_BASE_URL=http://127.0.0.1:7510/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/ make e2e-gateway
make verify-merge
```

## Working tree

Uncommitted #8 work: `ui/dev-proxy.ts`, `ui/src/dev-proxy.test.ts`,
`ui/vite.config.ts`, `ui/tsconfig.json`, `README.md`, `BACKLOG.md`. #7 is
committed in `72672f6`, #3 in `8bba3e2`, #1/#2/#4/#5/#6 in `ba81747`.

No WASM changed, so `published/` and the local deployment still match
(`make check-artifacts` passes). Commit this tree before clearing context.

