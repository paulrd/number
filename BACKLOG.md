# Backlog and handoff

Durable state for the project. Read this with `README.md`, then the design docs:
`DESIGN.md` (v4/v5), `DESIGN-v6.md` (private address book, signed names),
`DESIGN-views.md` (what the two surfaces may contain, + revision 3),
`DESIGN-payments-lca.md` (payments whose endpoint is the LCA).

The app's display name is **Tally**; the repository, crate names, WASM
filenames and `number.*` secret keys stay `number`, because renaming them
changes the compiled bytes and re-keys every zone.

## Current state (2026-11-01)

| Item | Value |
|---|---|
| Webapp id | `BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k` |
| Live URL | `<any live node>/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Live publish target | operator's VPS peer, API via the SSH-forwarded `:7509` |
| Contract | **v6** `CsFEfMWUH6ai22TWHWqExoL7nvgnHCCGz6TfbVMAcRbw` |
| Delegate | **v10** `6RQvoNj3CQV2AWTruyuExE3gMcXyxWK2cmE47rPXowrV`, code `AmbYHZnEfQ8n5vZmbWT6XQU4iVTAhx9Ua9swy6QD5nBe` |
| Live owner identity | `3f8411470c801051120a0ff14b5ab571c5660df42c17bc72677c37f2505c27b0` |
| Live zone (v6 instance) | `5vwEEpEBENdqKCVsHH1qqtyZ8rtP7pA2jFroSTBWB4dL` — dormant `selfName` `Dad`, root, one mutual child `Tim` |
| Live site | version `1793623025`, bundle `assets/index-WgQsBRqF.js`, identical on `7509`/`7511`/`7512`/`7513` |
| Tooling | `freenet` 0.2.153 (`310e494`), `fdev` 0.3.315; CI pin `FREENET_VERSION` 0.2.151 |
| Local node | `:7510` stopped, loopback-only. When started it will not fetch the live site; run `fdev --port 7510 website update --key number-local ui/dist` |
| Artifacts | `published/manifest.json` is the source of truth for the address |
| Last UI publish | 2026-11-02, `3e99567`; no WASM change, contract/delegate generations unchanged |

What the app does now, in one paragraph: one personal **zone** per owner with
eight child slots and a **private** address book in the delegate; a tree of
zones where an edge exists only when both sides point at each other; a zone has
no name of its own — the only names are the labels a parent signs into its child
slots (`childNames`), while `selfName` stays in v6 state but is dormant; a zone
with any link can pay or be paid, including when an endpoint is the LCA
(implicit issue / burn); the delegate auto-advances payment legs in the
background when the node grants Background; the UI shows your own zone only,
with the parent left unmentioned on the simple surface unless the link is
missing, and everything else behind Advanced.

## Open items

Ranked by what a next session should care about. Nothing here blocks the current
deployment.

1. **Address-book import marker cannot persist (#ours, small).** The app runs in
   a sandboxed, opaque-origin iframe where `localStorage` throws, so the
   once-only marker is never written. Consequence is benign: the import happens
   during v5→v6 migration and the automatic repair never runs, so a deleted
   contact is never resurrected. The durable home is a delegate secret, which is
   a v11 re-key.
2. **No cross-device address book (#ours, design).** Contacts live in the
   delegate; the exported identity (payload v2) carries them and restore brings
   them back. That is the backup of record; there is no sync.
3. **Contact validation duplicated (#ours, cleanup).** Rules exist in
   `delegate/src/lib.rs`, `ui/src/delegate.ts`, `ui/src/identity.ts` and
   `ui/src/mock.ts`. The delegate is the authority; consolidate before adding
   rules.
4. **Contact rename does not re-sign `childNames` (#ours, documented).** The
   child keeps seeing the name signed with the slot until the parent saves the
   slot again. Copy says so; do not let a future UI imply otherwise.
5. **`StateV6` is `deny_unknown_fields`; `Delta` and `Summary` are not
   (#ours, intentional).** State is strict so peers agree on bytes; a peer can
   still send ignored delta keys. Documented here, not in the design docs.
6. **#22 — the node shell does not render the Background grant prompt
   (upstream, blocked).** App side is solved: unregister + reinstall from the app
   triggers the prompt, and `/permission/{nonce}/respond` with `index: 0` grants
   it without changing owner or zone. A headless install can still wait on an
   unrendered prompt and leave the component Configured-but-inert. Evidence:
   `reports/upstream-background-grant-prompt.md`; filed as freenet/freenet-core
   #6039.
7. **freenet-stdlib#140 (upstream, workaround in place).** `SubscribeResponse`
   is serialised as `PutResponse`; the UI treats a subscribe timeout as
   "unconfirmed" and probes-then-PUTs. Remove the workaround when fixed.
8. **#15 Atlas listing (blocked externally).** Atlas is a read-only crawler
   index with no publisher submission. The site is live and usable by a fresh
   node but unlisted. Revisit when self-submission ships, or ask the operator to
   crawl it.

### Accepted limitations (not defects)

- **Issued, not delivered.** A stalled downward payment leaves the amount issued
  at the payer until they withdraw or overwrite the slot; the UI says so. This
  follows from allowing an LCA endpoint.
- **Auto-advance needs the node's Background capability.** The app cannot grant
  it and cannot observe the decision (it infers it from `lastScan`). When it is
  not running, `Check for payments` and the manual sentence stay, so a leg can
  still advance. Decision 2026-11-01: keep that fallback and the in-app off
  switch rather than promise something the node can refuse.
- **No zone navigation.** Removed deliberately; protocol reads of neighbouring
  zones (values, links, routes) remain.
- **Mutual-only child slots.** A one-sided slot is treated as absent, listed
  separately as unconfirmed with Clear, and never routed through. Signed state is
  never auto-tombstoned.

## Rules that must not be broken

- `published/` is the deployed address. Change it only with
  `make record-artifacts`, only after the outgoing generation is in
  `ui/src/migrations.ts`, and only when `make check-artifacts` passes.
- Before changing contract WASM: append the outgoing hash to
  `LEGACY_CONTRACT_CODE_HASHES` if the new contract accepts its state, else to
  `UNMIGRATABLE_CONTRACT_CODE_HASHES`. Only the former is probed for migration.
- Before changing delegate WASM: append the outgoing key, code hash and webapp
  id to `LEGACY_DELEGATES`. Never remove a registry entry.
- The build remap namespace (`/cargo`, `/rustup`, `/build`) is frozen; changing
  a root re-keys everything.
- Signing domains are frozen for every recorded generation: `number:v2:slot`,
  `number:v2:contacts` (legacy only since v6), `number:v3:parent`,
  `number:v4:payments`, `number:v5:adjustments`, `number:v6:selfname`,
  `number:v6:childnames`.
- The owner public key is the stable anchor; the contract id moves with the
  contract WASM.
- Delegate import is refused once a seed exists. Anything that must survive an
  import (counters, contacts) is written **before** the seed.
- The payment route table is implemented twice — `ui/src/payments.ts` and
  `delegate/src/advance.rs`. Any change to it must land in both, driven by the
  same fixture-tree table, or the app and the unattended signer disagree about
  money.
- `selfName` is dormant: the v6 field and its signing domain stay for
  compatibility, but the UI must not write, read or display it. Child-slot
  names (`childNames`, signed by the parent) are the only live names.
- User-facing copy says **zone**; code identifiers, CSS ids/classes, signing
  domains and crate/file names keep `board`/`number` because renaming them
  changes bytes and re-keys everything.

## Verify

```bash
make check              # contract + delegate fmt/clippy/tests, UI build+tests
make check-artifacts    # byte-equality against published/
make e2e-offline        # built UI + mock backend, includes axe
make verify-merge       # merge laws against the v6 corpus
FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ make e2e-gateway
# live nodes (through the SSH forwards)
node ui/e2e/readiness.mjs    # grants, addresses, scans, subscriptions
node ui/e2e/links.mjs        # parent tree + slot references, cycles
```

Expected at the time of writing: contract 123 tests, delegate 74, UI 227,
offline e2e 22, `verify-merge` 14 laws / 0 violations.

## Live four-node test bed

VPS `unstate.ca`, APIs through local SSH forwards; four `freenet network`
services running as `paul` from `~/.local/bin/freenet` (0.2.153).

| Node | Unit | Ports | Role / owner |
|---|---|---|---|
| D | `freenet.service` | ws 7509, default network port (no flags; default data dir) | root, owner `3f84…` — the live zone above |
| A | `freenet-node2` | ws 7511, net 31338 | root, owner `ea14…` |
| B | `freenet-node3` | ws 7512, net 31339 | child `0` of A, owner `4e7a…` |
| C | `freenet-node4` | ws 7513, net 31340 | child `03` of B, owner `06e6…` |

A/B/C keep data, config and logs under `/var/lib/freenet-nodeN/`; D uses the
default `~/.local/share/freenet`.

Last full topology check 2026-10-29; re-run `readiness.mjs` before relying on it.
All four previously held the Background grant and scanned; a delegate re-key
means each zone must be opened once so the seed migrates and the prompt is
asked again.

## Publishing (manual)

```bash
make build && make record-artifacts        # only when a WASM changed
fdev --port 7509 publish --code delegate/build/freenet/number_delegate \
     --parameters delegate/webapp_contract_id.bin delegate
fdev --port 7509 website update --key number-local ui/dist
```

The website key lives at `~/.config/freenet/website-keys/number-local.toml`
(this machine only; the VPS holds no keys). `fdev publish` alone does not arm
wake-ups — the app-origin install from the site does.

## Done

Newest first. Earlier work is summarised by commit; `git log` has the detail.

**2026-11-02 — zones (`8271776`, site `1793620651`; copy `794f870`, site `1793621397`)**
- User-facing copy says **zone**; identifiers, ids and signing domains keep
  `board`. No contract/delegate change, no re-key.
- A zone has no name of its own: the name row, Rename action and name dialog
  are gone; `selfName` is dormant (never written, read or seeded), and
  `childNames` are the only live names.
- Simple view: `Your zone` plus a quiet octal address; the record card is
  labelled `Balance` and never names the parent; the parent prompt with
  `Add a parent` appears only when the link is missing/broken. Children stay on
  the simple view. Changing/clearing a healthy parent lives in Advanced.
- Follow-up `794f870`: the record card is labelled `Balance`; the provenance
  caption is gone.
- Receive links take `name=` from the parent-given child name, else omit it.
- `DESIGN-views.md` Revision 3; `DESIGN*.md` carry a terminology note.

**2026-11-02 — owner id and child ids (`3e99567`, site `1793623025`)**
- Simple view: a quiet `Your id` row after the actions shows the shortened
  64-hex user id; the full key is the title and the copy control writes it to
  the clipboard with a visible `Copied.` result.
- Advanced child slots and the simple children list show the child's shortened
  user id (full key in the title); unconfirmed rows do not.
- UI only; no contract/delegate, state or signing change. `DESIGN-views.md`
  Revision 4.

**v6 → v10 (2026-11-01, current lineage)**
- `81bb25d` LCA-endpoint payment routes (implicit issue/burn) in UI and delegate;
  board navigation removed.
- `65c3ea6` children and parent on the default view; header copy removed;
  `Your Board Name:` label; manual payment controls conditional on auto-advance.
- `6b77fff` live-deploy fixes (contract id survives reconnect; import-marker
  warning demoted) + docs.
- `53b4dcf` leaf-first default view and the advanced page.
- `c1c54ad` contract v6 + delegate v9: private address book in the delegate,
  signed `selfName`/`childNames`, v5→v6 migration with contact import, legacy
  heal. `DESIGN-v6.md`.

**Earlier**
- `4fd9793` live board link audit; `88ea976` upstream issue recorded;
  `d38a30a` Background-prompt issue filed; `ee70b3f` #26 non-leaf warning;
  `bfc1141` #25 rerunnable smoke; `5d88595` #24 stuck state;
  `130ec53` #23 stale own-board refresh; `c57064f` readiness check;
  `8481cb1` unscanned ≠ stale; `5f42976` #22 app-side prompt;
  `f4ebadc` live smoke harnesses; `3a214f2` Clear stuck payment;
  `9460c91` delegate v8 auto-advance; `e1b5b6e` v5 issue/burn;
  `cfd6388` resolve_owner prefers committed state.
- `a95ca9e` v3 tree; `5ddf3b7` board-name/header UI `5ddf3b7`;
  `e0a64b5` tree-read timeout; `e1301f5` v2 address book + hundredths.
- Earlier still: `ba81747` (#1/#2/#4/#5/#6), `8bba3e2` (#3 reproducible build),
  `72672f6` (#7 verify-merge), `5c9a84e` (#8 dev proxy), `2f6ee8c` (#9 port
  consistency), `9eb7a35` (#10 identity export/import), `cce462a` (#11 exact
  i64), `0658c1c` (#12 live deploy), `1da4fa3` (#14 delegate bootstrap).
- Resolved items no longer tracked separately: #13 (upstream report,
  freenet-stdlib#140), #16 address book, #17 tree, #18 board names/header,
  #19 parent value + octal address, #20 cooperative payments (v4), #21 v4.1/v5
  auto-advance + issue/burn, #23 stale committed copy, #24 complete-vs-blocked,
  #25 stateful live smoke, #26 non-leaf auto-advance warning.

## Generation history

Newest first. **Never remove an entry**; the record gate and
`migrations.test.ts` enforce that every superseded generation is registered.

- Contract **v6** `CsFEfMWUH6ai22TWHWqExoL7nvgnHCCGz6TfbVMAcRbw` — current.
- Contract v5 `5YKHJAKaLcMoKaM9nhXJweGytK6CpDvsskEzPfFJ3jrg` — migratable (v6
  drops `contacts` and adds empty name records; all other signatures survive).
- Contract v4 `C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT` — migratable.
- Contract v3 `7j8ycU22TP9CfgGCk1nztWe6nqiasM6TS71Lg2fj9WPg` — migratable.
- Contract v2 `A1J4T4sJ4xwRtbbu8QpXhCSyMHrW1uMp2H4H5BfBdiur` — migratable.
- Unmigratable: `6h9ugwNX5JxgXhadYvvLp8Eu1jPMRe46zXQnAKrRpt57` (unsettled v4),
  `6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX` (v1), `3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd`
  (pre-remap build), `7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez` (first v1).
- Delegate **v10** `6RQvoNj3CQV2AWTruyuExE3gMcXyxWK2cmE47rPXowrV` /
  `AmbYHZnEfQ8n5vZmbWT6XQU4iVTAhx9Ua9swy6QD5nBe` — current.
- Delegate v9 `9a34iJr7yK1RRV3tAu3jp7nTSkPYMb6ySv9HeTGXh7vA` / `Cnfyn…` — v6
  data layer; registered.
- Delegate v8 `8G5M9XNyrZC7kYmpnrJPtBA3N29DdmhGfAa4KoMfdwWg` / `3PoWy…` —
  auto-advance + stale-cache fix; registered.
- Older registered generations (v7 and earlier) are in `ui/src/migrations.ts`.
  The very first delegate `8GpT86YK…` predates `export` and is permanently
  unrecoverable; its zone is abandoned, as are the test-only `44uPSHVv…`.

## Handoff notes

- The four VPS services are system units owned by root but run as `paul`; a
  restart needs interactive sudo (`sudo systemctl restart freenet freenet-node2
  freenet-node3 freenet-node4`).
- Nodes were upgraded from freenet 0.2.151 to 0.2.153 on 2026-11-01; old
  binaries are kept as `~/.local/bin/{freenet,fdev}.0.2.151.bak` on both hosts.
  CI still pins 0.2.151.
- What a fresh session should do first: run `make check` and
  `make check-artifacts`, then `node ui/e2e/readiness.mjs` against the live
  nodes; if the delegate was re-keyed, open each zone once.
