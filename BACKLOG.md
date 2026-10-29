# Backlog and handoff

This file is the durable state for the project. Read it with `README.md` and
`DESIGN.md` before starting a fresh session.

## Current state

Published on the live Freenet network (same webapp id as local; the website key
did not change). The local node remains the owner's node. v3 (boards as a tree)
is recorded in `published/` and deployed to both the local node and the live VPS
peer; the live test identity opens the v3 contract as a root board.

| Item | Value |
|---|---|
| Local node | `127.0.0.1:7510` (loopback-only) |
| Webapp id | `BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k` |
| Local URL | `http://127.0.0.1:7510/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Live URL pattern | `<any live node>/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Live publish target | operator's VPS peer, API reached through the SSH-forwarded `:7509` |
| Live test identity | `3f841147…505c27b0` (fresh, created on the VPS peer for the #12 smoke test) |
| Live test board | `3v52c7az…rEvmrEkW` (slot 1 = `42`, seq 1; v1 only, abandoned by the v2 re-key) |
| Live bootstrap | delegate WASM bundled in the site; first-run install on consent (#14) |
| Current delegate key | `8G5M9XNyrZC7kYmpnrJPtBA3N29DdmhGfAa4KoMfdwWg` (v8, current; `Fwgf…`, `5C2sivo…` and earlier are registered legacy generations) |
| Current delegate code hash | `3PoWyq37qCRhFNzjhYzedtyqxHA6saaj3NBJyj993Jrb` |
| Current contract code hash | `5YKHJAKaLcMoKaM9nhXJweGytK6CpDvsskEzPfFJ3jrg` (v5) |
| Owner identity | `7193df714c57b79be0fb550f3150ccb0a23680dd2ccc305cef87a712c244e351` |
| Owner board contract id | `9x5e6rygfV58TPC3S6qncZ9ENTZ4x4pEoJ3oSVXsSPtv` (v3; v2 `Ge6f…` migrates into it) |
| Live v4 test board | `EFegBMVna68Rn7VhXxYeRavJBCXLWJqqsXpKeA5Q7wKo` (live test identity `3f84…`; root “Dad”; slot 1 “Alice” = `12.00`) |
| Stage v4 test board | `FkZL1LQ14QKjW236t6hBAUk5Qpa1ybXiVNhy3mu2ouZ5` (`:7512`, identity `4e7a…`; “Alice” parent “Dad”) |
| Slot 1 | empty (v2 board was new; the v1 board `4JkW…` remains unmigratable) |
| Published artifacts | `published/manifest.json` (source of truth for the address) |
| Live site | v5 + v8 deployed and identical on `7509`/`7511`/`7512`/`7513`; bundle `assets/index-DK_anGpc.js` |
| Tooling | local `freenet` 0.2.151 (restarted), `fdev` 0.3.313; CI pin 0.2.151 |
| VPS peer | four network nodes on `unstate.ca`, APIs reached through local SSH forwards |
| Local node | stopped at the last deploy; when started, run the 7510 website update to pick up the UI-only change |

**Four-node live test bed (2026-10-29).** VPS `unstate.ca`; APIs reached through
local SSH forwards. A `:7511` root, owner `ea14…`; B `:7512` child at `0`,
owner `4e7a…`; C `:7513` child at `03`, owner `06e6…`; D `:7509` was child at
`01` for the smoke, now a root again, owner `3f84…`. B's slots hold C `90.00`
(slot 3) and D `110.00` (slot 1) after the payment. All four nodes hold the
number app's Background grant and scan: A was re-granted first, then D
(`pass 4`); `node ui/e2e/readiness.mjs` reports all four READY.


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

### #16 — Address book and two-decimal values (v2)

- The address book is signed contract state: `contacts {seq, entries, sig}`,
  entries `{label, userId}` with `userId` a 32-byte Ed25519 public key (64
  lowercase hex). It is capped at 64 entries, merged with the same
  seq/signature order as slots, and synced in summaries and deltas.
- A slot entry now stores a mandatory `contact` (`userId`), not a free-text
  label. The editor selects from the address book; adding a contact is a
  signed write. Removing a contact leaves its key on existing slots (they show
  `Unknown · <short id>`) and does not invalidate signed state.
- `value` is an optional i64 **count of hundredths**; blank saves `0.00` and the
  UI always shows exactly two decimals. The full range is
  `-92233720368547758.08` … `92233720368547758.07`.
- Delegate protocol v4: `signContacts`, `contactsNextSeq`, v2 signing domains.
  The seed and slot-counter secret keys are unchanged, so the existing
  forward-only delegate migration carries the owner key.
- The contract is a **breaking generation**: v1 state cannot be re-PUT into v2.
  The v1 contract hashes are in `UNMIGRATABLE_CONTRACT_CODE_HASHES`; the UI does
  not probe them. Same owner key, fresh v2 board.
- New recorded artifacts: contract `A1J4…`, delegate code `CmXA…`, delegate key
  `BN6E…`. `make check-artifacts` and `make verify-merge` pass (293 cases, 14
  laws, 0 violations); offline e2e covers add/remove contact, decimals, blank
  zero, the cents bounds, axe, and a clean console.

### #17 — Boards as a tree (v3)

- Contract v3 adds a signed single-`parent` record (`{seq,userId,sig}`) with
  its own monotonic sequence, summary pair, delta, and merge. The 8 slots are
  children; a slot's `contact` is the child board owner. At most one parent is
  enforced by the single record; self-parent is rejected. The contract cannot
  enforce mutual agreement, cycles, or unique children across boards.
- A tree edge is **mutual**: the parent has a slot for the child and the child's
  parent points back. The UI shows linked/pending/not-created/previous-version;
  only mutual edges make breadcrumbs. A v2 board can be a parent (slots are
  signed) but must be opened in v3 to become a child.
- UI: own board stays live/editable; other boards are read-only. Parent
  set/change/clear with a best-effort cycle check, breadcrumbs capped at 32 with
  cycle detection, child link status in the editor, `Open child board`, Home,
  and duplicate/self child rejection. The address book edits the own board only.
- Migration: **v2 is migratable**. v3 keeps the v2 slot/contacts signing bytes;
  the client adds an empty parent and re-PUTs the signed state. The v4 delegate
  export migrates its seed/counters; `parentNextSeq` defaults to 1. v1 remains
  unmigratable.
- New recorded artifacts: contract `7j8y…`, delegate code `FHGW…`, delegate key
  `FtdT…`. Verified: contract 75 tests, delegate 21, UI 97, `make check-artifacts`,
  `make verify-merge` (293 cases, 14 laws, 0 violations), offline e2e 4/4
  (including the tree, parent, read-only, pending, duplicate, axe).
- Deployed to the local node and the live VPS peer through `:7509`. Gateway
  smoke passed on both (local 16.7 s, live 21.8 s). The live test identity is on
  the v3 contract `BtZs…`, root with 8 empty slots, no console errors. Existing
  v2 boards migrate on first load by adding an empty parent; v2 delegate seeds
  and counters migrate through `LEGACY_DELEGATES`.
- Header polish (`88e7602`): the Board meta row is hidden on the own board
  (Identity + Back up identity is the single board/identity summary) and appears
  as **Viewing** with the owner, read-only/version badges, and Home when another
  owner's board is on screen. UI-only, deployed in place; no re-key.

### #18 — Board names and header clarity

- A board's name is the owner's own entry in the existing signed address book
  (self-contact label). No contract/delegate change and no re-key. Other boards
  read it from the target state and use the fallback order: relevant address-book
  label → target board's own name → shortened id. This applies to the path,
  Viewing row, parent/child link labels, and slot labels (lazy name resolution).
- The owner is required to name their board on first load; the dialog cannot be
  dismissed until saved. A Board name row renames it. The self-entry is hidden
  from the contact list/pickers/count; every contacts save preserves it. The
  address book reserves the board name/id and shows 63 other slots.
- Header: Identity group, Board name (own) or Viewing (remote) + Parent,
  Contacts, and a collapsed Details section. The Contract id is only under
  Details now; group separators were added.
- Edge: a board already at the 64-contact cap must remove one contact before it
  can add its self-entry; normal boards are capped at 63 others. The required
  dialog surfaces the backend limit error.
- Verified: UI 97 unit tests, offline e2e 8/8 (prompt, rename/duplicate/
  reservation, fallback names, Details, axe, clean console), build/tsc.
- UI-only; no WASM/artifacts change. Committed as `5ddf3b7`; the live site was
  updated and the live gateway smoke passed (14.0 s). The local node was stopped
  at deploy time (connection refused), so its stored site still needs
  `fdev --port 7510 website update --key number-local ui/dist` once it is up;
  the source/dev server already has the change.
- Known edge: a board at the 64-contact cap must remove one contact before the
  required name dialog can add its self-entry; normal boards are capped at 63
  other contacts and the backend limit error is shown in the dialog.

### #19 — Parent value and octal address

- A board with a parent now shows the value the parent holds for it in a
  prominent band above the slot grid: the parent's signed slot entry for the
  child, with its value (two decimals), unit, note, and zero-based slot. It is
  hidden for a root, a pending/unreadable/not-created parent, or a cleared
  parent slot. Own and read-only boards both show it.
- Every board displays an octal address: zero-based slot digits from the root
  with no separator. A root is the empty string; a child appends its slot digit
  (`0`–`7`) to its parent's address. The address is derived by walking mutual
  parent links, not stored; a pending/missing/unreadable/looping/over-deep chain
  is shown as unsettled rather than guessed.
- UI-only: no contract, delegate, schema, wire, or signing change, so the
  current WASM artifacts, delegate key, contract id, and webapp id are unchanged.
- `ui/src/tree-view.ts` adds `childSlotIndex`, `parentValueFor`, and
  `octalAddress`; `ui/src/tree-view.test.ts` covers roots, 0-based digits,
  multi-level prefixes, pending/not-created/unreadable/loop cases, and a legacy
  parent. Offline mock fixture value is `8.50 kg` so e2e can assert the band.
- Verified: UI unit tests 106/106 (including 9 tree-view cases), `tsc`/build,
  offline e2e 8/8 with axe while the parent band is visible. Committed as
  `f1981cc`.
- Deployed UI-only: `website update` through the forwarded `:7511` staging peer,
  then confirmed the live `:7509` peer serves the same new assets
  (`index-DhtyiHEf.js`, `index-C--X85rJ.css`). Gateway smoke passed on both
  `:7511` (14.9 s) and `:7509` (13.6 s). No contract/delegate/artifact change,
  so the webapp id, contract id, and delegate key are unchanged.

### #20 — Cooperative payments (v4)

- State v4 adds a signed `payments` record: at most one active intent per board,
  with `id/src/dst/amount/srcAddr/dstAddr/cursor/phase/status/next/fail/legs`.
  It merges like parent/contacts, has its own summary pair, delta field and
  `number:v4:payments` signing bytes. Slot/contacts/parent signing bytes are
  unchanged, so v3 boards migrate by adding an empty payments record.
- A payment is a sequence of signed legs, not a transaction. The source writes
  the offer; each ancestor up to the LCA debits its slot; the LCA applies the
  debit and credit in one delta; each destination-side ancestor credits; the
  destination's parent verifies the user id. A board's inbox is its parent plus
  its eight children; owners advance it manually. There is no push/timeout.
- A debit that would go below `0.00` aborts before signing. A missing
  destination, mismatched user id, failed leg or later superseding write starts
  a reverse walk. Reverse checks the exact leg `seq`+`sig`; it never overwrites
  a later write, and reports `superseded`/`blocked` rather than pretending to
  undo it. One active payment per board; a settled source can start the next.
- UI: payment ledger panel, source dialog (octal address + user id + amount),
  inbox with `Sign my leg`/`Undo my leg`, status card, `Check for payments`,
  read-only/offline-safe. No visual change to slots or header.
- Migration: v3 contract hash `7j8y…` and v3 delegate key `FtdT…` registered,
  plus the first, unreleased v4 build (`6h9u…`, `8ChE…`) so the record gate
  cannot orphan it; that first v4 board schema is marked unmigratable. Final
  artifacts: contract `C8An…`, delegate code `48A8…`, delegate key `6FN3…`.
  Delegate version 7 carries `paymentsNextSeq` through identity/export/import
  (old backups default it to 1).
- Verification: contract 88 tests, delegate 26, UI 149, offline e2e 9/9
  (including a real LCA payment and a source offer), `make check`,
  `make check-artifacts`, `make verify-merge` (293 cases, 14 laws, 0
  violations), production build. Visual review light/dark/mobile.
- Oracle gate: blockers B1–B4 (source-slot binding, reverse/source-close
  binding, intermediate settlement, settled replay) fixed; attempt 2 cleared.
  Known Phase 1 limits: the settled window is 8 ids; the browser cannot verify
  Ed25519; discovery is manual; unequal-depth routes change the touched sum by
  design. A multi-device same-seed payment race is pre-existing and can lose the
  record merge while slot writes win.
- Deployed: published delegate `6FN3…` and the v4 site to the stage `:7512`
  peer, then the live `:7509` peer. The stage board (`FkZL…`, “Alice” under
  “Dad”) and the live test board (`EFeg…`, root “Dad”, slot 1 “Alice” 12.00)
  migrated from the registered v3 predecessor. First load took ~30 s on the
  live peer (delegate predecessor probes + legacy board GET); a warm load smoke
  passed on both (`:7512` 13.5 s, `:7509` 14.1 s).
- The first load exposed a UI transition bug: the payments panel stayed hidden
  when `ready` arrived after the state render. Fixed by repainting payments from
  `paintStatus`; UI-only redeployed. Live DOM check confirmed the panel visible
  and the root board disables “Make a payment…” as intended.
- Post-deploy diagnosis: a payment from address `03` to `5` initially returned
  the old generic route error because at least one board on the path had not yet
  been opened in v4 (the error did not name which). After opening Bob `03`,
  Alice `0`, Dad (root), and Tim `5`, every edge was Linked/current and the route
  planned (`03 → root → 5`, 3 hops). UI-only update `767ac65` now names the
  specific `pending`/`not-created`/`legacy` board and detail, and adds
  **Withdraw offer** for a source offer with no signed leg. Redeployed to all
  four nodes (`7509`, `7511`, `7512`, `7513`); gateway smoke passed.
- "Check for payments" is now always enabled while the panel is visible: it is a
  read-only cache refresh, so it must not be locked behind an in-flight write or
  navigation. The first live payment completed after the owner signed: `1.00`
  from Bob `03` to Tim `5` (Alice slot for Bob `87.80`; Dad slot for Alice
  `11.00`; Dad slot for Tim `45.40`).

### #21 — v4.1/v5: background auto-advance and issue/burn

- Delegate v8 declares `lifecycle=[node_started]`,
  `capabilities=[background]`, `wakeups=[inbox=300]`; it stores the configure
  payload, resolves/subscribes to the boards on its routes, scans them, enforces
  checks (a)–(g), dedups, and keeps a bounded audit. The LCA debit+credit is one
  signed delta. `signAdjustment` is carried but dormant.
- Contract v5 adds the signed `adjustments` record; the UI exposes Issue/Burn
  per slot and keeps the parent-value band in sync.
- `resolve_owner` prefers the node's committed local state over the lossy
  `ContractNotification` cache, with a regression test.
- Artifacts: contract `5YKH…` (unchanged), delegate `Fwgf…` / code `4ems…`;
  `5C2s…` is the registered legacy generation, so seeds and counters migrate.
- Verification: contract 116, delegate 53, UI 195, 321 merge cases,
  `make check-artifacts` OK, 9 offline e2e. Live smoke 2026-10-29 with B as the
  LCA: C `90.00`, D `110.00`, B audit `leg 2, slots 3, 1, lca`, C payment
  `Complete 10.00 along 03 → 01`; D restored to root afterwards.


## Remaining

### #15 — Atlas listing (blocked)

Atlas (2026-10-27) is a read-only, crawler-built index with no submission
control; its README says publisher self-submission is still taking shape. The
site is live and now usable by a fresh node, but not listed (searching "number"
or the contract id returns 0). Revisit when Atlas ships self-submission, or ask
the Atlas operator to crawl it.

### #22 — Background grant prompt is not rendered by the node shell

- A (`:7511`, node2) never scanned: `lastScan=0`, no subscriptions, even after a
  node restart. B (`:7512`, node3) scanned every ~5 minutes. The node gates
  lifecycle events and wake-ups on the Background capability grant, and it asks
  for that grant only when the *app-origin* registration arrives; a raw
  re-register (no origin) is ignored. Node 0.2.151's shell does not render the
  node-authored prompt, so a headless install can wait on an invisible prompt
  and leave the component "Configured" and permanently inert.
- **App-side resolved 2026-10-29.** `UnregisterDelegate` + reinstall from the
  app triggers the prompt; the delegate's secrets survive (on-disk key is
  `BLAKE3(code_hash || params)`). Answering `/permission/pending` nonce with
  `index: 0` at `/permission/{nonce}/respond` granted A and D without changing
  their owners or boards. All four nodes now report a grant and scan.
  `live-smoke-b.mjs` answers the prompt during install, the UI shows
  "No scans" / "Configured, no scans" when `lastScan` is 0 (190 UI tests), and
  `node ui/e2e/readiness.mjs` checks every node's grant, address, scan,
  subscriptions and last error (all READY on 2026-10-29: A pass 20, B pass 66,
  C pass 55, D pass 4).
- **Upstream remains:** a node whose shell lacks the permission overlay gives
  the user an install that waits on an unrendered prompt. The node should
  render it (the app correctly cannot self-grant; the prompt is node-authored).
  Evidence and repro: `reports/upstream-background-grant-prompt.md`.
- Deployed 2026-10-29: all four nodes serve
  `index-DK_anGpc.js` (the detection UI, the #23 delegate key and the #24 stuck state).

### #23 — A stale committed copy still beats the network

- Reproduced in the 2026-10-29 smoke: B's committed copy still carried the old
  forward payment while a GET saw the terminal record, so `plan_leg` returned
  `Busy` and the delegate never re-GETted.
- Fixed in delegate `8G5M9…` / code `3PoWy…`:
  - `resolve_owner` chooses the fresher of the committed local state and the
    notification cache by `(payments.seq, max slot seq)` instead of always
    trusting local; the cache is refreshed from the winning copy.
  - A `Busy` plan issues one GET for the own board and stops planning that run;
    the response lands in the cache and the next scan re-plans from the newer
    record.
  - Tests: fresher cache wins, and Busy requests the own GET (53 delegate
    tests).
- Re-keyed all four nodes from `Fwgf…` to `8G5M9…`: added `Fwgf…` to
  `LEGACY_DELEGATES`, ran `make record-artifacts`, published the packaged
  delegate, deployed the new site, and opened each board so the seed migrated
  from `Fwgf…`. Owners and boards are unchanged; the old delegate was then
  unregistered on each node so only one actor remains. `fdev publish` alone does
  not arm wake-ups (no app origin); the app-origin reinstall in each board did.
- Verified: a 1.00 payment C→D through B completed with the new delegate (C
  89.00, D 111.00), then restored to 90.00/110.00 with v5 issue/burn and D was
  cleared to root. `readiness.mjs` is READY on all four nodes after the re-key.

### #24 — "Complete" progress can hide a blocked raw record

- `paymentProgress` follows `next` to a terminal copy on another board, so the
  card showed "Complete 1.00…" while B's own record was still forward and
  `plan_leg` returned `Busy`. The Clear action existed but was easy to miss.
- Fixed:
  - `isStuckForeignRecord` distinguishes a stuck non-source forward record from
    a source's expected offered copy after settlement.
  - The status card paints a distinct **Stuck** badge/state with the raw
    record's amount and route, says a later copy is settled, and points at
    Clear. "Make a payment" is disabled with the same explanation.
  - Clear stays visible whenever the raw entry is non-terminal; its title
    explains when the network copy is already settled.
  - Five new tests (195 UI tests).
- Deployed in `index-DK_anGpc.js` to all four nodes; readiness is READY.

### #25 — Live smoke preconditions are stateful

- `ui/e2e/live-smoke-b.mjs` expects B to hold 100.00 against C and D; after a
  pass it holds 90.00/110.00. Rerunning needs a reset (issue/burn back) or a
  documented precondition/skip flag. The harness now clears a stuck B record
  before offering.

### #26 — Warn when a non-leaf board cannot auto-advance

- #22's "No scans" badge is per board. A board with live children (or a root
  with two child subtrees) can be an intermediate on a payment path; if its
  node lacks the Background grant or has never scanned, payments through it
  stall silently. "Live" means the child's own parent link points back, not
  just that a slot labels it.
- Next: detect that condition with the address walk and show "This board can
  carry payments but won't auto-advance on this node", with the reinstall /
  allow guidance from #22.
- Optional tree-wide view: for a planned route, check every intermediate node's
  `/permission/grants` + `lastScan > 0`. That check is operator-side (loopback
  only); the app's sandboxed iframe cannot read another node's grants endpoint.
  `ui/e2e/readiness.mjs` is the current per-node version.

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
- `3ViRVk2ScELVVmk4bjJVWS33dD6SiSmTbSQ1b8yDHVdZ` — previous, code hash
  `7SMgeUTjfdkYtay446EVLruxSwukeYKTozHiPSxUeKDY`, pinned to the webapp above.
  Superseded by v2; registered in `LEGACY_DELEGATES`, so its seed migrates
  forward.
- `BN6Egqx27gcue4VNyDs4Qqt8uzYwVZsphfS62RKKcNef` — previous (v2), code hash
  `CmXAPVyVH7MmEp3apB89sCkQsgqje5cZXxzuQHCmeVNj`. Superseded by v3; registered
  in `LEGACY_DELEGATES`.
- `FtdTGtdvZT3j71nr8yF2L7qsqdLTdwKrWfjMSoPg7iEb` — **current (v3)**, code hash
  `FHGW7JXm4XPdTo5ezG5wThTd6CCVAEmQEFM8vJB1mdjH`. Recorded in
  `published/manifest.json`; append to `LEGACY_DELEGATES` before the next
  delegate change (the record gate enforces it).
- Contract `7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez` — old v1 hash,
  registered as unmigratable. Board `9UpJtiFg…`.
- Contract `3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd` — pre-remap build,
  registered as unmigratable. Board `EgbCX4Csk7nmA4cNB7CGQ4sxLKwtJPjjcEF1HntpgZkF`.
- Contract `6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX` — v1, reproducible,
  registered as unmigratable in v2. Board
  `4JkW7tMySXeg4vzsFGcnEyXpq7NNjGBGd9eQmqRGgbsk`.
- Contract `A1J4T4sJ4xwRtbbu8QpXhCSyMHrW1uMp2H4H5BfBdiur` — previous (v2),
  address book + hundredths. Board
  `Ge6fPDvarU7qiGBRQk69bXst4yqdpRLtdMHLMSNkrwaC`. Registered in
  `LEGACY_CONTRACT_CODE_HASHES` (migratable: v3 keeps the slot/contacts signing
  bytes and adds an empty parent).
- Contract `7j8ycU22TP9CfgGCk1nztWe6nqiasM6TS71Lg2fj9WPg` — **current (v3)**,
  boards as a tree. Board
  `9x5e6rygfV58TPC3S6qncZ9ENTZ4x4pEoJ3oSVXsSPtv`. Recorded in
  `published/manifest.json`; append to `LEGACY_CONTRACT_CODE_HASHES` or
  `UNMIGRATABLE_CONTRACT_CODE_HASHES` before the next contract change.

## Rules that must not be broken

- `published/` is the deployed address. Change it only with
  `make record-artifacts`, and only after the outgoing generation is in
  `ui/src/migrations.ts`; `make check-artifacts` must pass.
- Before changing contract WASM, append the outgoing hash to
  `LEGACY_CONTRACT_CODE_HASHES` if the new contract accepts its state, otherwise
  to `UNMIGRATABLE_CONTRACT_CODE_HASHES`. Only the former is probed for state
  migration; the latter keeps a breaking generation registered for the gate.
- Before changing delegate WASM, append the outgoing key, code hash, and webapp
  id to `LEGACY_DELEGATES`.
- Never remove a migration registry entry.
- The build remap namespace (`/cargo`, `/rustup`, `/build`) is frozen: changing
  a replacement root re-keys everything.
- The slot/contacts signing domains (`number:v2:slot`, `number:v2:contacts`) are
  frozen while v2-board migration is supported. Changing them makes the v2
  generation unmigratable; do it only with a deliberate break and a registry
  move.
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
# live nodes (through the SSH forwards): grants, addresses, scans, subscriptions
node ui/e2e/readiness.mjs
```

## Working tree

The v4.1/v5 and delegate v8 work is pushed to `origin/main`:

- `9460c91` delegate v8 background auto-advance
- `e1b5b6e` contract v5 issue/burn adjustments, UI and docs
- `cfd6388` `resolve_owner` prefers the committed local state; new `Fwgf…`
  delegate generation
- `3a214f2` owner **Clear stuck payment**
- `f4ebadc` live-node smoke harnesses
- `5f42976` warn when auto-advance never scans (#22)
- `8481cb1` don't call an unscanned delegate stale
- `c57064f` background readiness check (all four nodes READY)
- `130ec53` stale own-board refresh (#23); delegate `8G5M9…`
- `5d88595` stuck payment status (#24); UI 195 tests

`published/` records the v5 contract (`5YKH…`) and delegate `Fwgf…` / code
`4ems…`; `make check-artifacts` proves the bytes. The live four-node bed is
described above. All four nodes hold the Background grant and scan; `node
ui/e2e/readiness.mjs` reports all READY. Open items: #22 (upstream shell
prompt), #23–#26; #15 is blocked externally. The working tree is clean; the
ad-hoc probes were deleted after the smoke.

Earlier history: the v3 tree change is `a95ca9e`, the header merge `88e7602`,
the current-generation tree-read timeout `e0a64b5`, and the board-name/header UI
`5ddf3b7`; the v2 address-book change is `e1301f5`. #13's report is
freenet-stdlib#140; #14 is `1da4fa3`, #12 `0658c1c`, #11 `cce462a`, #10
`9eb7a35`, #9 `2f6ee8c`, #8 `5c9a84e`, #7 `72672f6`, #3 `8bba3e2`, and
#1/#2/#4/#5/#6 `ba81747`. The local `:7510` child remains stopped and
ring-isolated on the phone hotspot (`zero ring connections` /
`RING_TRANSPORT_DESYNC`), so its parent’s child side stays “Not created”; this
is connectivity-limited, not a data mismatch.

Handoff notes:
- The VPS nodes run 0.2.151. Pre-update backups (ephemeral, in `/tmp/opencode`):
  `number-node-backup-0.2.150/` and `freenet-0.2.150/{freenet,fdev}`.
- The upstream issue is <https://github.com/freenet/freenet-stdlib/issues/140>;
  the UI workaround (subscribe timeout = unconfirmed, probe-then-PUT) remains
  until it is fixed.
- Site and delegate updates on the VPS are manual (`fdev --port <port> website
  update --key number-local ui/dist`, `make publish-delegate`); the four-node
  API is reached through SSH forwards from the development machine.

