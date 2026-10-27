# Upstream report: `SubscribeResponse` is serialized as `PutResponse`

> **Status:** prepared and committed; **not filed** (no GitHub credentials in the
> environment, and the owner chose to leave it in the repo). To file, use the
> title/repo below and paste from "## Summary" onward.

- **Repository:** `freenet/freenet-stdlib`
- **Suggested title:** flatbuffer client API serializes `SubscribeResponse` as
  `PutResponse`, so clients can never confirm or refuse a subscription

## Summary

On a subscribe, the node's flatbuffer client API sends a `ContractResponse`
whose union tag is `PutResponse` instead of `SubscribeResponse`. The TypeScript
SDK's `FreenetWsApi.subscribe()` waits for `SubscribeResponse { subscribed:
true }`, so every subscribe times out even when the subscription is active, and
a `subscribed: false` refusal is indistinguishable from a timeout.

## Environment

- `freenet` 0.2.151 / `fdev` 0.3.313 (re-verified after the update from
  0.2.150; unchanged), `freenet local` on a loopback WS API
- `@freenetorg/freenet-stdlib` 0.4.0 (TypeScript client)
- Chromium via Playwright; the app was served through the gateway shell, but
  the shell forwards WebSocket frames verbatim — this is a server-side
  serialization issue, not a shell issue.

## Observed

The client sends a `ContractRequest` with `contractRequestType = Subscribe`.
The next `ContractResponse` frame has `contractResponseType = PutResponse`
instead of `SubscribeResponse`. Captured timeline (milliseconds after the
socket opened):

```text
   13 SENT ContractRequest ... cr=Get
   37 RECV ContractResponse cr=GetResponse
   47 SENT ContractRequest ... cr=Subscribe
   47 RECV ContractResponse cr=PutResponse      <-- expected SubscribeResponse
  ... [freenet] subscription unconfirmed; live deltas may still arrive
 12393 READY (subscribe() gave up after its 12s timeout)
```

Re-verified on 0.2.151: `Subscribe` at 44 ms, `PutResponse` at 44 ms, no
`SubscribeResponse`, timeout at 12.4 s. The arm below is still present on
`main` (line ~1469).

Deltas continue to arrive, so the subscription itself is active. A
`subscribed: false` response (subscriber limit, refusal) can never be observed.

The unexpected `PutResponse` is also a response-correlation hazard: a client
that matches pending PUTs by response type can consume it as the answer to a
different request.

## Cause

`rust/src/client_api/client_events.rs` still serializes the variant as a
`PutResponse`:

```rust
ContractResponse::SubscribeResponse { key, .. } => {
    // SubscribeResponse FBS type not yet in generated code,
    // serialize as PutResponse (same shape: just a key) so
    // the client receives a valid response instead of a crash.
    ...
    let put_offset = FbsPutResponse::create(
        &mut builder,
        &PutResponseArgs { key: Some(key_offset) },
    );
    let contract_response_offset = FbsContractResponse::create(
        &mut builder,
        &ContractResponseArgs {
            contract_response_type: ContractResponseType::PutResponse,
            contract_response: Some(put_offset.as_union_value()),
        },
    );
```

The comment is stale in the current tree: the generated Rust code on `main`
contains the real type (`rust/src/generated/host_response_generated.rs` has
`contract_response_as_subscribe_response` and the `subscribed` accessor), the
flatbuffer schema (`schemas/flatbuffers/host_response.fbs`) defines
`SubscribeResponse { key; subscribed: bool; }`, and the TypeScript SDK already
decodes it. If the shipped node is pinned to an older generated module,
regenerate it first; otherwise only this arm needs updating. Either way the
`subscribed` flag is dropped today.

## Suggested fix

Serialize the real variant, including `subscribed`:

```rust
ContractResponse::SubscribeResponse { key, subscribed } => {
    // build FbsSubscribeResponse { key, subscribed }
    // union tag: ContractResponseType::SubscribeResponse
}
```

Add a round-trip test asserting the union tag and both `subscribed` values, and
a TS-client test that `subscribe()` resolves on `true` and rejects on `false`.

## Related observation (not this bug)

While capturing this, a `GET` for a contract that does not exist returned `Ok`
acknowledgements and no `NotFound` within the client's 4-second probe (the
client then PUTs and reads back). That may be GET latency / a different
path rather than a dropped response; the shell forwards frames verbatim. Worth
a separate investigation if `NotFound` is expected promptly for a missing
instance.
