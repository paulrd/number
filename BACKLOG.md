# Backlog and handoff

This file is the durable state for the project. Read it with `README.md` and
`DESIGN.md` before starting a fresh session.

## Current state

Published on the live Freenet network (same webapp id as local; the website key
did not change). The local node remains the owner's node.

| Item | Value |
|---|---|
| Local node | `127.0.0.1:7510` (loopback-only) |
| Webapp id | `BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k` |
| Local URL | `http://127.0.0.1:7510/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Live URL pattern | `<any live node>/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Live publish target | operator's VPS peer, API reached through the SSH-forwarded `:7509` |
| Live test identity | `3f841147…505c27b0` (fresh, created on the VPS peer for the #12 smoke test) |
| Live test board | `3v52c7az…rEvmrEkW` (slot 1 = `42`, seq 1) |
| Live bootstrap | delegate WASM bundled in the site; first-run install on consent (#14) |
| Current delegate key | `3ViRVk2ScELVVmk4bjJVWS33dD6SiSmTbSQ1b8yDHVdZ` |
| Current delegate code hash | `7SMgeUTjfdkYtay446EVLruxSwukeYKTozHiPSxUeKDY` |
| Current contract code hash | `6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX` |
| Owner identity | `7193df714c57b79be0fb550f3150ccb0a23680dd2ccc305cef87a712c244e351` |
| Board contract id | `4JkW7tMySXeg4vzsFGcnEyXpq7NNjGBGd9eQmqRGgbsk` |
| Slot 1 | `7` (preserved by the #3 re-key migration) |
| Published artifacts | `published/manifest.json` (source of truth for the address) |
| Tooling | local `freenet` 0.2.151 (restarted), `fdev` 0.3.313; CI pin 0.2.151 |
| VPS peer | update instructions given; not updated from this environment — check `freenet --version` there |

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

### #9 — Port consistency

`make node` started the default `:7509` while README/local verification used
`:7510`, and `fdev` defaults to `7509` too. On a dev box 7509 can be an SSH
forward or a system service, so a command relying on the default writes to the
wrong node. (Hit in practice: a read-only `fdev website list` without `--port`
went to a forwarded VPS peer.)

- Ports and directories are variables: `WS_PORT` (7510), `NETWORK_PORT`
  (31337), `NODE_ROOT` (`/tmp/opencode/number-node`), plus
  `ISOLATED_WS_PORT` (7511), `ISOLATED_NETWORK_PORT` (31338) and
  `ISOLATED_NODE_ROOT`.
- `make node` uses them, creates the directories (freenet refuses a missing
  config dir) and stays loopback. `make node-isolated` starts a second node on
  7511 for publish/migration tests that must not touch the UI's node.
- `make dev` derives `FREENET_NODE_URL` from `WS_PORT`.
- Every fdev invocation passes `--port` (`publish-delegate`, and the README and
  `record-artifacts` recipes); the README explains why fdev's 7509 default is
  unsafe here.
- Verified: `make node-isolated` served 7511 while the UI node stayed up on
  7510; both were stopped/left intact; dry-runs show the expected ports; no
  target or script invokes fdev without `--port`.

### #10 — Identity export/import for users

The seed lived only in the local delegate, so a user could not move to another
device. The delegate already had `export`/`import`; the UI did not expose them.

- `ui/src/identity.ts` is the versioned backup codec: JSON with `kind:
  number-identity`, seed, 8 counters, and an informational pubkey/createdAt.
  It validates shape and user-facing errors before anything reaches the
  delegate.
- First-run choice (`ui/src/identity-dialog.ts` + `onIdentityRequired`): when
  the delegate has no seed after legacy migration, the board does not create
  one. It waits for an explicit **Create a new identity** or **Restore from a
  backup**. Escape/backdrop cannot fall through to creating a key; a failed
  restore stays inline so it can be retried.
- Backup (`Back up identity` in the Identity row): the code is only fetched
  after **Reveal backup code**, shown in a readonly field, with copy/download;
  cleared on hide or close. Never stored or logged.
- Restore is only offered on first run, because the delegate refuses to replace
  an existing seed; the backup dialog explains that and points at the new
  device. The backup carries the key, not the board: the new device derives the
  same contract key and loads the board from Freenet (needs network access).
- Verified against real nodes: exported from the main node, imported into a
  fresh delegate on the isolated node. Identity matched
  (`7193df71…`), the first save on the empty board landed at `seq 2` (counters
  carried from `nextSeq[0]=2`, not a fresh 1), a garbage code was rejected
  inline without creating a key, and the code was cleared on hide/close. The
  create path on a second fresh delegate produced a new identity and a working
  backup. The deployed gateway app (sandboxed iframe) also reveals a valid
  backup code with a clean console.

### #11 — Exact i64 beyond `Number.MAX_SAFE_INTEGER`

The premise here was that this needed a schema change (decimal strings) and
therefore a contract re-key plus migration. It does not: the wire format was
already an i64 **JSON number**, and both serde_json and the delegate parse that
exactly. The lossy layer was the UI's `Number` conversion.

- `ui/src/state.ts`: `Entry.value` is now a `bigint`. State/delta JSON is
  parsed with `lossless-json` (unsafe integers become bigint, safe ones stay
  numbers) and emitted with its stringifier, so big integers stay unquoted JSON
  numbers on the wire. The contract and delegate are unchanged.
- Editor: no longer rejects values above 2^53 and no longer warns about them;
  it accepts the full i64 range and reports only real bounds errors. Delegate
  sign requests use the lossless stringifier too; the offline mock digest is
  JSON-safe.
- Verification: unit round-trip of `i64::MIN`/`MAX` and `±(2^53+1)` (encoded
  text contains the exact digits, decode returns the same bigint; a legacy
  small-number state decodes to bigint). Offline e2e saves `i64::MAX`, reopens
  it with the exact digits, and rejects `i64::MAX + 1`. On the isolated node,
  MIN/MAX/`2^53±1`/`-1`/`0` were saved through the delegate and reloaded from
  the contract exact, each at `seq 1`; `MAX + 1` was refused. `make check`,
  `make e2e-offline` and the gateway e2e pass.
- **No re-key and no migration.** `make check-artifacts` still matches
  `published/`. The local site was updated with the new UI.

### #12 — Live-network deploy and Atlas submission

- Published the website contract to the live network through the VPS peer
  (`fdev --port 7509 website publish --key number-local ui/dist`). The webapp id
  did not change, so the delegate pin and existing site address stay valid;
  the local node (7510) is unaffected.
- Verified live end-to-end through the gateway shell: installed the delegate
  on the VPS peer, the first-run dialog appeared, created a fresh test identity
  (`3f841147…`) and board (`3v52c7az…`), saved `42`, reloaded, and the value
  and `seq 1` persisted with a clean console. The owner identity was **not**
  copied to the VPS.
- Side effect: the VPS peer now holds that fresh seed, so it cannot import the
  owner backup later without clearing the delegate secret first (import refuses
  when a seed exists). The owner board stays on the laptop node (7510).
- Atlas: the live Atlas is read-only (126 entries, crawler-built, search only)
  and its README says publisher self-submission is still taking shape. There is
  no submission action to perform; searching "number" or the contract id
  returns nothing yet. Tracked as #15.

### #14 — Delegate bootstrap for live users

The live site worked only on a node where `number-delegate` was registered;
a fresh node had no way to install it (the client API does not fetch delegates
from the network).

- `scripts/build.sh` copies the raw delegate WASM into `ui/public`, and Vite
  injects its URL. The site archive went from ~134 KB to ~204 KB compressed
  (7 files).
- `DelegateClient.register()` builds `RegisterDelegate` (`WasmDelegateV1`:
  code, code hash, parameterised key, webapp id params; cipher/nonce zeros,
  ignored by the node), verifies `BLAKE3(code) == delegateCodeHashBytes` first,
  sends it, and polls `status` until the delegate answers.
- `OnlineBoard.ensureDelegate()` runs after connect. A missing delegate is not
  answered by the client API (the node only logs), so a status timeout is the
  only signal; it is treated as "may need installing". The consent dialog
  (`delegate-dialog.ts`) is explicit — no auto-install, no silent dismissal —
  and declining stops the board with "Delegate not registered" plus a clear
  sentence. Offline mode never shows it.
- Verified through the gateway on a fresh isolated node: prompt → install →
  identity setup → create → save `42` → reload persisted, no prompt on the
  second load, clean console. Declining shows the error notice and no board.
  The live and local sites were updated with the new build; the VPS node
  already has the delegate and skips the prompt.
- No WASM change: `make check-artifacts` still matches `published/`; no re-key.
  `make check` (46 UI tests), both offline specs and the gateway spec pass.


### #13 — Upstream response report

The original note blamed the gateway shell for dropping
`SubscribeResponse`/`NotFound`. A frame capture corrected that: the shell
forwards every frame. The real defect is in freenet-stdlib's client-event
serializer — `SubscribeResponse` is sent with the `PutResponse` union tag (a
stale "not yet in generated code" workaround), so clients never see the
confirmation or a refusal and `subscribed` is dropped. The missing `NotFound`
observation is separate: a GET for a missing board got `Ok` acknowledgements
and no `NotFound` within the 4 s probe (possibly GET latency), not a dropped
frame.

- Report with the captured timeline, source pointer, impact and suggested fix:
  `reports/upstream-subscribe-response.md`.
- **Filed:** <https://github.com/freenet/freenet-stdlib/issues/140>
  (2026-10-27), with cross-references to #131 (the GET/NotFound observation)
  and #106 (request ids, which would contain the stray `PutResponse` hazard).
- Re-verified on 0.2.151 (2026-10-27): still present. Subscribe → `PutResponse`
  at 44 ms, no `SubscribeResponse`, timeout at 12.4 s; the serializer arm is
  unchanged on `main`.
- The UI workaround stays: subscribe timeout = "unconfirmed"; probe-then-PUT.
  The `freenet.ts` comments, README and DESIGN §11 now describe the real cause
  instead of blaming the shell.

## Remaining

### #15 — Atlas listing (blocked)

Atlas (2026-10-27) is a read-only, crawler-built index with no submission
control; its README says publisher self-submission is still taking shape. The
site is live and now usable by a fresh node, but not listed (searching "number"
or the contract id returns 0). Revisit when Atlas ships self-submission, or ask
the Atlas operator to crawl it.

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

Clean. #13's report is committed and filed as freenet-stdlib#140; #14 is in
`1da4fa3`, #12 in `0658c1c`, #11 in `cce462a`, #10 in `9eb7a35`, #9 in
`2f6ee8c`, #8 in `5c9a84e`, #7 in `72672f6`, #3 in `8bba3e2`, #1/#2/#4/#5/#6 in
`ba81747`.

No WASM changed, so `published/` and the re-key are untouched. The local and
live sites serve the #14 build (delegate bundled). The VPS test seed from #12
remains; the isolated test nodes were wiped. The only open backlog item is
#15 (Atlas), which is blocked externally.

Handoff notes:
- The local node was restarted on 0.2.151 with the same data/config dirs.
  Pre-update backups (ephemeral, in `/tmp/opencode`):
  `number-node-backup-0.2.150/` and `freenet-0.2.150/{freenet,fdev}`.
- The upstream issue is <https://github.com/freenet/freenet-stdlib/issues/140>;
  the UI workaround (subscribe timeout = unconfirmed, probe-then-PUT) remains
  until it is fixed.
- The VPS runs the live site. Updating it is a manual step because this
  environment has no SSH: use the release installer only if it is a supervised
  default install, otherwise `FREENET_NO_SERVICE=1` and restart the existing
  unit/command (see the conversation/handoff notes).

