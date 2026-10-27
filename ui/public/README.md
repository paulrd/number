# public assets

`number_contract.wasm` is not checked in. The contract crate cannot be built in
this environment yet.

The repository build script (`scripts/build.sh`) is expected to:

1. build `contract/` to the canonical raw WASM artifact whose BLAKE3 is the
   contract code hash;
2. copy that artifact to `ui/public/number_contract.wasm`;
3. write the build-time constants consumed by `vite.config.ts` next to the UI
   `package.json`:
   - `contract_code_hash.txt` — the code hash, base58 (one line; consumed);
   - `delegate_key_bytes.json` — the published delegate key as a JSON array of
     32 integers (consumed);
   - `delegate_code_hash_bytes.json` — `BLAKE3(delegate wasm)` as a JSON array
     of 32 integers (consumed).

The script also writes `contract_code_hash_bytes.json`, `delegate_key.txt`, and
the artifacts under `ui/public/`; those are ignored by git.

`vite.config.ts` also accepts `CONTRACT_CODE_HASH`, `DELEGATE_KEY_BYTES`, and
`DELEGATE_CODE_HASH_BYTES` environment variables, which is useful for CI.

Until the artifact and constants exist, the app starts in a clearly labelled
"contract build missing" state (or "delegate build missing" if the delegate
constants are absent). It does not silently address a different contract.

For local UI work that needs no node at all, use:

```sh
VITE_OFFLINE_MODE=1 npm run dev
# or
npm run build:offline && npm run preview
```

Offline mode is an in-memory mock. It derives a deterministic mock owner and
contract key, exercises the real state/codec/merge code, and resets when the
page reloads.
