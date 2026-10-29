# Upstream report — 0.2.151 has no Background permission prompt UI

Date: 2026-10-29
Node: `freenet 0.2.151 (39773c33c870)`, build `2026-10-27T17:03:07Z`

Filed upstream: <https://github.com/freenet/freenet-core/issues/6039>
Observed on `:7509`, `:7511`, `:7512`, `:7513` (four network nodes on one VPS).

## Summary

The node enforces the `background` capability and exposes the permission API,
but the pages it serves have no UI to show or answer a pending prompt:

- `GET /permission/pending` returns the pending prompt.
- `POST /permission/{nonce}/respond` grants it.
- `GET /permission/grants`, `POST /permission/grants/revoke` and
  `/permission/apps` work (the page lists and revokes remembered grants).
- The shell page (`GET /`) and `/permission/apps` contain no reference to
  `/permission/pending`, `/permission/events/ws` or `/permission/{nonce}/respond`.

The `permission_prompts` module documentation describes a shell overlay that
subscribes to `/permission/events/ws` and posts the chosen index. That overlay
is not in this build's served shell, so a first registration that asks for
Background blocks on a prompt nothing can answer. The app cannot self-grant:
the prompt is node-authored, and the app's sandboxed iframe (`Origin: null`)
cannot pass the loopback/trusted-Origin gate on the permission routes.

## Reproduction

1. On a node with the app installed but no grant:

   ```bash
   curl -s http://127.0.0.1:7511/permission/grants
   # {"grants":[]} for the number app
   ```

2. Unregister and reinstall the delegate from the app page (an app-origin
   `RegisterDelegate`; a raw re-register with no origin does not prompt):

   ```bash
   curl -s http://127.0.0.1:7511/permission/pending
   # [{"nonce":"…","author":"node",
   #   "message":"The Freenet app BZBEeX3… wants to: run when it is installed…",
   #   "labels":["Allow","Not now"], …}]
   ```

3. The install waits. The shell page has no overlay:

   ```bash
   curl -s http://127.0.0.1:7511/ > /tmp/shell.html
   grep -c 'permission/pending\|events/ws' /tmp/shell.html
   # 0
   grep -o 'permission/[a-z/{}_-]*' /tmp/shell.html | sort -u
   # permission/apps only
   ```

4. Answer through the API:

   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     -H 'Origin: http://127.0.0.1:7511' \
     -d '{"index":0}' \
     http://127.0.0.1:7511/permission/<nonce>/respond
   # {"ok":true}
   curl -s http://127.0.0.1:7511/permission/grants
   # {"app":"BZBEeX3…","capability":"background","state":"granted"}
   ```

5. The node then arms the manifest's wake-up schedule; the delegate's
   `lastScan` advances and `wakeups_delivered` climbs. Without the answer the
   delegate is permanently inert (no lifecycle events, no wake-ups) while its
   configuration looks healthy.

## Impact

Any app whose delegate declares `capabilities = [background]` and is installed
on this node for the first time gets a registration that waits on an
unrendered prompt. The delegate is installed but never runs in the background.
The app can only detect and explain this; it must not be allowed to answer the
prompt itself.

## Expected behaviour

The shell (or the Apps and permissions page) should render pending prompts and
POST the chosen index, as `permission_prompts.rs` documents. At minimum,
`/permission/apps` should surface pending prompts rather than only remembered
grants, so a user can recover without the API.

## Workaround used here

`UnregisterDelegate` + reinstall through the app, then answer
`/permission/pending` with `index: 0` and a trusted `Origin` header. The
delegate's secrets survive (its on-disk key is `BLAKE3(code_hash || params)`),
so the owner and board are unchanged. See `ui/e2e/readiness.mjs` for the
post-grant check and `live-smoke-b.mjs` for the install-time prompt answer.
