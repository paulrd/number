# Freenet stale contract reads — findings

Date: 2026-11-08. Freenet 0.2.155 (`5aa241a`). Researched against the
freenet-core source at `/tmp/opencode/freenet-core` (clone during the review).

## Symptom

Two public VPS nodes each hold the same v6 zone contract. Node A (7511)
updates it (signed slot delta). Node B (7512) still returns the old state to
GET, even with a subscribed/blocking GET and `fdev execute subscribe`, and
still did after 6+ minutes. B's own client GET log says
`phase="local_cache" is_subscribed=true has_local_interest=true`.

The same flow on one node (two app origins) works immediately, so the app
logic is not the difference.

## Bottom line

- A client GET on a node that already holds the contract **always serves the
  local copy**. There is no freshness flag and no supported "refresh this
  copy" operation.
- `fetch_contract` only controls whether the WASM is returned; it is mapped
  to `return_contract_code` in freenet-stdlib 0.12.1.
- `subscribe` / `blocking_subscribe` register a listener and interest; they do
  not fetch state when a local copy exists.
- UPDATE is broadcast only to **advertised co-hosts** (the sender's proximity
  cache of connected peers that host the contract), not to all holders and not
  to a subscriber list.
- Missed updates heal via anti-entropy: an interest heartbeat every 300 s, and
  field reports of 40–75 minutes at shared-set scale (#5527). Not prompt.

## Code references

- `crates/core/src/client_events.rs:193` — `should_serve_local_copy`
  (`local_satisfies_request && (connection_count == 0 || is_subscribed ||
  has_local_interest)`).
- `crates/core/src/client_events.rs:1071` — client `ContractRequest::Get`.
- `crates/core/src/client_events.rs:1238` — local-cache serve branch;
  `subscribe`/`blocking_subscribe` handling.
- `crates/core/src/operations/get.rs:72` — wire GET fields: instance id,
  `fetch_contract`, htl, visited, subscribe. No summary/version.
- `crates/core/src/operations/get/op_ctx_task.rs:2577` — `maybe_subscribe_child`
  (subscription only, no state fetch).
- `crates/core/src/operations/subscribe.rs:466` —
  `fetch_contract_if_missing`; short-circuits when the contract is present.
- `crates/core/src/operations/update.rs:496` — `get_broadcast_targets_update`;
  targets come from `advertised_cohost_pub_keys` (proximity cache), interest
  manager source removed in #4642.
- `crates/core/src/contract/executor/runtime/contract_ops.rs:42` — a re-PUT is
  merged through `update_state`, committed, and emits the normal broadcast.
- `crates/core/src/node/network_bridge/p2p_protoc/broadcast.rs:179` —
  `handle_broadcast_state_change`.
- `crates/core/src/ring/interest.rs:77` and `ring.rs:1728` — 300 s interest
  heartbeat; `node.rs:3920` emits `SyncStateToPeer` for stale peers.
- `docs/design/demand-driven-hosting.md` — update mesh is the connected
  sub-graph of hosts; a holder outside that sub-graph silently goes stale.

## What does not force a refresh

- `GetT { fetchContract: true, subscribe: true, blockingSubscribe: true }`.
- `ContractRequest::Subscribe { summary }` — the summary is local listener
  state, not a wire fetch.
- `fdev execute subscribe` / `fdev execute get` (no refresh command exists).
- An empty-delta UPDATE.

## Supported recovery paths

1. **Subscribe before the write, keep the socket open.** The candidate/client
   must be registered as a co-host on the path *before* the owner writes.
   This is necessary but not sufficient if the nodes are not in the same
   update mesh (measured: the owner's update targeted two co-hosts, while the
   candidate's subscription was routed through a different peer, so it never
   received the delta promptly).
2. **Owner re-PUTs / re-broadcasts the full state.** Safe: a re-PUT takes the
   existing-contract branch, merges through `update_state`, and broadcasts —
   but it still only reaches the same co-host set. It does not reach a
   disconnected stale holder.
3. **Push the state into B out-of-band, then B applies it** (`fdev execute
   update <KEY> --as-state <FILE>`), which merges locally and rebroadcasts.
4. **Evict B's local copy, then GET/subscribe** — with no local body,
   `fetch_contract_if_missing` actually fetches current state. This is a local
   reset, not a client refresh flag.
5. **Wait for anti-entropy** — correct eventually, minutes to tens of minutes.

## Known issues

- #5842 — consecutive UPDATE broadcasts to the same peer can be lost.
- #5527 — anti-entropy repair latency (300 s minimum; 40–75 min in the field).
- #5190 — summary-notification target suppression can leave a peer stale until
  the heartbeat.
- #5069 — evicted-but-not-reclaimed contracts can still serve stale GETs.
- #4868 — over-budget peers can permanently diverge.
- #4681 — cross-node subscriber can miss a committed update notification.

## Implication for number/Tally

Cross-node admission cannot rely on the candidate's GET of the owner's zone
being fresh. Options for the handoff design:

- **Signed admission payload**: the owner's app emits a signed assignment
  (owner, slot, region address/cell, zone contract id/owner id) that reaches
  the candidate through a channel they can verify (link, copy, or a message),
  and the candidate's app verifies the owner signature, shows the region, and
  signs `parent`. This avoids zone-state propagation entirely.
- **Shared gateway**: serve the app from one node so both identities share
  the contract store. Changes the deployment/privacy model.
- **Explicit latency**: keep the subscription and tell the user admission may
  take minutes; not acceptable for a first-run join.

The subscription code (`watchBoard`) is still correct and useful for nodes in
the same update mesh; keep it as an accelerator, not the guarantee.
