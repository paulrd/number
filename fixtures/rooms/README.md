# Room fixtures

Golden vectors for the members-room contract (`room/`, P3a) and its P3b
TypeScript consumers.

## `golden_v1.json`

Produced by:

```sh
cd room && cargo run --example gen_golden > ../fixtures/rooms/golden_v1.json
```

Fields:

- `tag` — must be `ZMR1`. The owner and tag are covered by both signatures.
- `owner_seed_hex`, `author_seed_hex` — Ed25519 private-key seeds. Ed25519
  signing is deterministic, so these regenerate the vector exactly.
- `owner_vk_hex` — 32-byte owner verifying key, lowercase hex. Parameters are
  `hex("ZMR1" as ASCII) || owner_vk`; the parameters blob itself is
  `b"ZMR1" || raw owner_vk` (36 bytes).
- `membership.signing_bytes_hex` — canonical membership bytes
  (`DESIGN-rooms.md` §3), lowercase hex.
- `membership.sig_hex` — owner signature over those bytes.
- `message.signing_bytes_hex` — canonical message bytes (§3).
- `message.sig_hex` — author signature over those bytes.
- `message.id` — `BLAKE3(raw signature bytes)[0..16]`, lowercase hex (32
  chars). Never stored in state.
- `state` — the full v1 state object (`v`, `memberships`, `messages`).
- `state_bytes_hex` — hex of the canonical compact JSON state bytes. The state
  struct's serde field order is declaration order and there is no whitespace.
- `digest` — `BLAKE3(state_bytes)[0..16]`, lowercase hex (32 chars), as used by
  the state summary.

Consumers must verify the signatures over `signing_bytes_hex`, validate the
state shape (bounds, ordering, membership at epoch) and check
`BLAKE3(state_bytes_hex)[0..16] == digest`.
