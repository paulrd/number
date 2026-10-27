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
| Current delegate key | `BPjm4EX38ag6SJG7ABA1H494nWCxVXo1GRM7UzC74SVX` |
| Current delegate code hash | `7GQ6yxU9x7KKBKfGyTx5MJysQQJjbYj8WQsG6L42xedh` |
| Current contract code hash | `3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd` |
| Owner identity | `7193df714c57b79be0fb550f3150ccb0a23680dd2ccc305cef87a712c244e351` |
| Board contract id | `EgbCX4Csk7nmA4cNB7CGQ4sxLKwtJPjjcEF1HntpgZkF` |
| Slot 1 | `7` (left by migration verification) |

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

### #5/#6 — Browser smoke and CI

- `ui/e2e/offline.spec.ts` — built UI + mock backend, save, axe, clean console.
- `ui/e2e/gateway.spec.ts` — gateway shell, iframe, identity, board readiness.
- `.github/workflows/ci.yml` — contract, delegate, UI, offline browser smoke,
  and `fdev verify-merge`.
- `make e2e-offline` and `make e2e-gateway`.

## Remaining

### #3 — Reproducible WASM build gate (next)

- Canonical build script remaps `CARGO_HOME`, `RUSTUP_HOME`, and the repo root;
  fail if a build-machine path survives into the WASM.
- Commit `rust-toolchain.toml`; build with `--locked` and per-crate target dirs.
- Commit published contract artifacts and parameters, or a code-hash registry.
- CI byte-equality check against the committed artifact.
- Add the migration-registry guard left over from #4: a contract/delegate WASM
  change must be accompanied by an appended registry entry.

### #7 — Make `verify-merge` meaningful

Current result: 34 cases, 0 violations, **0 enforceable**. Add delta/summary/
transition corpus entries so the delta-to-current-peer law is actually checked.

### #8 — Dev proxy

`npm run dev` cannot reach a node: no `/v1` proxy and no auth-token path in
`vite.config.ts`.

### #9 — Port consistency

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
- `BPjm4EX38ag6SJG7ABA1H494nWCxVXo1GRM7UzC74SVX` — current, export-capable;
  registered. Code hash `7GQ6yxU9x7KKBKfGyTx5MJysQQJjbYj8WQsG6L42xedh`.
- Contract `7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez` — old v1 hash,
  registered as legacy. Board `9UpJtiFg…`.
- Contract `3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd` — current.
  **Append this before the next contract change.**

## Rules that must not be broken

- Before changing contract WASM, append the outgoing hash to
  `LEGACY_CONTRACT_CODE_HASHES`.
- Before changing delegate WASM, append the outgoing key, code hash, and webapp
  id to `LEGACY_DELEGATES`.
- Never remove a migration registry entry.
- A predecessor pinned to a different webapp id cannot be called from the new
  UI; migrate before changing the webapp id.
- Delegates and contracts are content-addressed: any WASM change re-keys them.
- The owner public key is the stable anchor; the contract id moves with the
  contract WASM.

## Verify

```bash
make check
make e2e-offline
FREENET_BASE_URL=http://127.0.0.1:7510/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/ make e2e-gateway
make verify-merge
```

## Working tree

The code work from #1, #4, #5/#6 and the migration registry is uncommitted
(#2 was an operational key backup). The new files are:

- `.github/workflows/ci.yml`
- `delegate/webapp_contract_id.txt`
- `ui/e2e/`
- `ui/playwright.config.ts`
- `ui/src/migrations.ts`

Commit them before clearing context or starting a new branch.
