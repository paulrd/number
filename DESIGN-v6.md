# v6 wire format — private address book, signed names

> **Terminology (2026-11-02):** the UI now calls a board a **zone**, and a
> zone has no name of its own (only the parent-signed names in child slots
> remain). This is the historical spec for the wire format and keeps the
> old wording; field names, signing domains and crate names are unchanged.

Status: implementation spec for pass 1. Reviewed (oracle, attempt 1).

Two changes drive v6:

1. **The address book leaves contract state.** It moves into the delegate's
   secret store as `{label, userId, address}`, where `address` is an optional
   derived octal address used to route payments. Contacts therefore stop being
   replicated, public, signed data.
2. **Names become signed records on the board that owns them.** The owner names
   its own board (`selfName`); a parent names each child (`childNames`). This
   replaces the two naming tiers that read the address book today.

`slots`, `parent`, `payments` and `adjustments` are untouched: same JSON, same
canonical signing bytes, same merge rules. A v5 state's signatures keep
validating after the client migrates it, exactly as v4→v5 worked.

## 1. State

```json
{
  "v": 6,
  "selfName":   { "seq": 0, "name": null, "sig": null },
  "parent":     { "...": "unchanged from v5" },
  "childNames": { "seq": 0, "entries": [], "sig": null },
  "payments":   { "...": "unchanged from v5" },
  "adjustments": { "...": "unchanged from v5" },
  "slots": [ "8 entries, unchanged from v5" ]
}
```

`contacts` is **removed**, not deprecated in place. The v6 state struct must
carry `#[serde(deny_unknown_fields)]` so a peer cannot smuggle an unsigned
`contacts` blob into the encoded state, where two clients would then disagree
about bytes nothing validates. For the same reason the v6 merge, validate,
summary and delta paths must not read or preserve a `contacts` key.

The client migrates a v5 state by dropping `contacts`, adding an empty
`selfName` and an empty `childNames`, and setting `v: 6`. No surviving record
is re-signed.

## 2. `selfName`

The name the owner gives their own board. One per board.

```json
{ "seq": 0, "name": null, "sig": null }
```

- `name` is `null` (never named, or cleared) or 1–64 bytes of UTF-8. A cleared
  name is `seq > 0` with `name: null` — a legal tombstone, same shape as the
  parent record's `userId: null`.
- `seq == 0` is the empty record: `name` and `sig` are `null`.
- `seq > 0` requires `sig`: 128 lowercase hex characters.

Canonical signing bytes (`DESIGN.md` §2 style):

```text
b"number:v6:selfname" || seq u64 LE || tag u8
// tag == 1:
// || len u32 LE || name bytes (UTF-8)
```

Merge: last writer wins on `seq`, ties broken by the signature string, matching
`merge_parent`.

## 3. `childNames`

The names a parent gives its children, keyed by the parent's own slot index.

```json
{ "seq": 0, "entries": [ { "slot": 0, "userId": "<64 lowercase hex>", "name": "Alice" } ], "sig": null }
```

- At most `SLOT_COUNT` (8) entries, in strictly ascending `slot` order, each
  `slot < 8`.
- `userId` is the child owner's 64-character lowercase hex public key: the same
  value the slot's `entry.contact` holds.
- `name` is 1–64 bytes of UTF-8 (an entry with an empty name is invalid; remove
  the entry instead).
- `seq == 0` is the empty record; `seq > 0` requires `sig` (128 lowercase hex).

Canonical signing bytes:

```text
b"number:v6:childnames" || seq u64 LE || count u32 LE
// per entry, in the given order:
// || slot u8 || userId 32 raw bytes || len u32 LE || name bytes (UTF-8)
```

Merge: whole-record last-writer-wins on `seq`, ties broken by signature, exactly
like `merge_contacts`. The delta carries the whole record when it changes.

**A name is authoritative only while it still describes the slot.** The contract
must not enforce a coupling between `childNames` and `slots`: records merge
independently, so a merged state may legally hold a name whose slot write lost
or was rebound to a different child. The binding is resolved by the reader: a
`childNames` entry is the parent's name for a child only when
`slots[entry.slot].entry.contact == entry.userId`. `userId` in the entry is what
makes that check possible, and it also means a cleared-then-reused slot index
cannot show a stale name.

## 4. Summary and delta

`Summary` replaces its `contacts: SlotSummary` member with two members:

- `selfName` — digest of the canonical signing bytes, or `(0, 016 zero bytes)`
  when `seq == 0`;
- `childNames` — same rule.

`Delta` (`v: 6`) drops `contacts` and gains `selfName` and `childNames` as
optional record members, following the existing `#[serde(default)]` pattern for
"unchanged". Every other member keeps its shape.

`verify-merge` must pass unchanged in kind: merge stays commutative,
associative, idempotent and closure-preserving over the new records.
`contract/examples/gen_corpus.rs` must generate v6 states, including non-empty
`selfName` and `childNames`, or the delta laws run over an empty corpus and the
suite proves nothing.

## 5. Delegate v9

The delegate becomes the sole owner of the address book, so it inherits the
invariants the contract used to enforce.

Secret keys (names are wire-visible; do not rename the existing ones):

| Key | Contents |
|---|---|
| `number.v9.contacts` | JSON array of `{ "label": string, "userId": string, "address": string \| null }` |
| `number.v9.nextseq.childnames` | next `seq` for `childNames` |
| `number.v9.nextseq.selfname` | next `seq` for `selfName` |
| `number.v2.nextseq.contacts` | retained for export compatibility; no longer incremented |

Address-book invariants, enforced in the delegate: at most 64 entries; unique
`userId` (64 lowercase hex); unique exact `label` (1–64 bytes); `address` is
`null` or a valid octal address of at most 32 digits (`0`–`7`, root is `""`).

Commands (per-entry read-modify-write inside the delegate, each returning the
resulting array; a whole-list setter would let two tabs clobber each other):

| Command | Effect |
|---|---|
| `contacts` | list the current entries |
| `contacts.add` | add one entry; rejects a duplicate `userId` or `label` |
| `contacts.update` | change `label` and/or `address` for one `userId` |
| `contacts.remove` | remove by `userId` |
| `signChildNames` | sign `{seq, entries}` with the v6 canonical bytes |
| `signSelfName` | sign `{seq, name}` with the v6 canonical bytes |

`OwnerCounters` grows `childNamesNextSeq` and `selfNameNextSeq`, surfaced on
`identity`, `export` and `import` like the existing counters.

Export payload: add `payloadVersion: 2`, the contacts array, and both new
counters. Import accepts a version 1 payload (no contacts, no new counters →
empty list and counters of 1) so an older backup still restores. Ordering inside
`import` matters: validate everything, then write counters and contacts, and
write the seed **last**, because the delegate refuses an import once a seed
exists — a post-seed failure would be unretryable. The same ordering applies to
`export`: read all of it before writing anything.

Migration: the v8 delegate key/code hash must be registered in
`LEGACY_DELEGATES` (`ui/src/migrations.ts`) before the new artifacts are
recorded; the same applies to the outgoing v5 contract hash, which belongs in
`LEGACY_CONTRACT_CODE_HASHES` because v5→v6 keeps every surviving signature.

## 6. UI migration (pass 2, listed here so the wire work is not blocked on it)

Order, per board: ensure the seed → read the v5 board from the legacy contract
instance → write its `contacts` into the delegate (address `null`) → write
`selfName` from the old self-entry (the entry whose `userId` is the owner) →
PUT the v6 state. Never PUT v6 when the delegate write failed. Keep the v5
instance readable for a later repair pass (legacy board readable ∧ delegate
contacts empty ⇒ offer the import again).

`childNames` is seeded at the same time from what the parent already had: for
each slot with a contact, look up that `userId` in the old `contacts` and take
its label. The child then sees the same name it saw before the migration.

Contacts that were public and signed under v5 stay public in the old instance.
Migration must not imply retroactive privacy.
