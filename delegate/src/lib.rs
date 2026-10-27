//! `number-delegate` — private key custody and slot signing for the number app.
//!
//! The delegate owns a single Ed25519 key pair. The 32-byte seed and a
//! per-slot monotonic sequence counter live in the delegate's secret store;
//! the matching public key is the owner key the `number-contract` instance is
//! parameterised by.
//!
//! All request/response payloads are JSON (UTF-8) inside
//! [`ApplicationMessage::payload`], exactly as specified in `DESIGN.md` §7.
//!
//! Core logic takes [`SecretStore`] rather than [`DelegateCtx`] so the whole
//! protocol can be exercised natively, where the host secret functions are
//! inert.

use ed25519_dalek::{Signer, SigningKey};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};

/// Number of slots on a board.
pub const SLOT_COUNT: usize = 8;

/// Metadata bounds from `DESIGN.md` §2, in UTF-8 bytes.
pub const MAX_LABEL_BYTES: usize = 64;
pub const MAX_UNIT_BYTES: usize = 16;
pub const MAX_NOTE_BYTES: usize = 512;

/// Secret-store key holding the raw 32-byte Ed25519 seed.
pub const SECRET_SEED: &[u8] = b"number.v1.seed";

/// Prefix for the per-slot `u64` little-endian next-sequence key.
pub const NEXTSEQ_PREFIX: &str = "number.v1.nextseq.";

/// Domain separator for the canonical signing bytes (`DESIGN.md` §2).
const SIGNING_DOMAIN: &[u8] = b"number:v1:slot";

/// Persistent secret storage, abstracted from the host.
///
/// Production passes a [`DelegateCtx`] (see the impl below); tests pass an
/// in-memory map. The trait deliberately mirrors only the two operations this
/// delegate needs, both of which are real host calls on WASM.
pub trait SecretStore {
    fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>>;
    fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool;
}

impl SecretStore for DelegateCtx {
    fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>> {
        DelegateCtx::get_secret(self, key)
    }

    fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool {
        DelegateCtx::set_secret(self, key, value)
    }
}

/// An optional string field. `null` and absent are equivalent on the wire; the
/// canonical signing bytes encode both as length `0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub value: i64,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl Entry {
    fn metadata_error(&self) -> Option<String> {
        check_len("label", self.label.as_deref(), MAX_LABEL_BYTES)
            .or_else(|| check_len("unit", self.unit.as_deref(), MAX_UNIT_BYTES))
            .or_else(|| check_len("note", self.note.as_deref(), MAX_NOTE_BYTES))
    }
}

fn check_len(field: &str, value: Option<&str>, max: usize) -> Option<String> {
    let len = value.map_or(0, str::len);
    if len > max {
        Some(format!("{field} is {len} bytes; maximum is {max}"))
    } else {
        None
    }
}

/// A request from the web UI, tagged by `cmd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Request {
    Identity,
    Sign {
        slot: u8,
        seq: u64,
        #[serde(default)]
        entry: Option<Entry>,
    },
}

/// `{"ok":true,"pubkey":"<64 hex>","nextSeq":[...]}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityResponse {
    pub ok: bool,
    pub pubkey: String,
    #[serde(rename = "nextSeq")]
    pub next_seq: [u64; SLOT_COUNT],
}

/// `{"ok":true,"sig":"<128 hex>"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignResponse {
    pub ok: bool,
    pub sig: String,
}

/// `{"ok":false,"error":"..."}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub error: String,
}

/// The delegate's JSON response. Untagged because the three shapes are
/// discriminated by their fields, exactly as shown in `DESIGN.md` §7.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Response {
    Identity(IdentityResponse),
    Sign(SignResponse),
    Error(ErrorResponse),
}

impl Response {
    fn error(message: impl Into<String>) -> Self {
        Self::Error(ErrorResponse {
            ok: false,
            error: message.into(),
        })
    }
}

/// The delegate implementation. Stateless: everything persistent is in the
/// secret store, everything temporary is per-call.
pub struct NumberDelegate;

#[delegate]
impl DelegateInterface for NumberDelegate {
    fn process(
        ctx: &mut DelegateCtx,
        _parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
        match message {
            InboundDelegateMsg::ApplicationMessage(message) => {
                // The single authorization boundary: every application request
                // goes through `handle_application_message`, which refuses a
                // non-WebApp origin before dispatching on `cmd`.
                let payload = handle_application_message(ctx, origin.as_ref(), &message.payload);
                Ok(vec![OutboundDelegateMsg::ApplicationMessage(
                    ApplicationMessage::new(payload),
                )])
            }
            _ => Err(DelegateError::Other("unexpected message type".into())),
        }
    }
}

/// Authorize a caller.
///
/// This delegate custodies a private key, so only an attested web app may use
/// it. Inter-delegate calls name the calling delegate, not the person, and an
/// unattested call has no caller at all. New `MessageOrigin` variants fail
/// closed through the wildcard arm.
pub fn authorize(origin: Option<&MessageOrigin>) -> Result<(), String> {
    match origin {
        Some(MessageOrigin::WebApp(_)) => Ok(()),
        Some(MessageOrigin::Delegate(caller)) => Err(format!(
            "refused inter-delegate call from {caller:?}: number-delegate only serves web apps"
        )),
        None => Err("refused unattested call: missing message origin".into()),
        _ => Err("refused unknown message origin: rebuild against a newer freenet-stdlib".into()),
    }
}

/// Handle one application payload: authorize, decode, dispatch, serialize.
///
/// Always returns a JSON response body; a malformed request or refused caller
/// becomes `{"ok":false,...}` rather than an error/panic.
pub fn handle_application_message(
    store: &mut impl SecretStore,
    origin: Option<&MessageOrigin>,
    payload: &[u8],
) -> Vec<u8> {
    let response = match authorize(origin) {
        Ok(()) => handle_request(store, payload),
        Err(error) => Response::error(error),
    };

    // The response shapes contain only strings, bools and u64s, so serialization
    // cannot fail; the fallback exists so this function never panics.
    serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"response serialization failed"}"#.to_vec())
}

/// Decode and dispatch one request against a secret store.
pub fn handle_request(store: &mut impl SecretStore, payload: &[u8]) -> Response {
    let request = match serde_json::from_slice::<Request>(payload) {
        Ok(request) => request,
        Err(error) => return Response::error(format!("invalid request: {error}")),
    };

    match request {
        Request::Identity => match identity_with(store) {
            Ok((pubkey, next_seq)) => Response::Identity(IdentityResponse {
                ok: true,
                pubkey,
                next_seq,
            }),
            Err(error) => Response::error(error),
        },
        Request::Sign { slot, seq, entry } => match sign_with(store, slot, seq, entry.as_ref()) {
            Ok(sig) => Response::Sign(SignResponse { ok: true, sig }),
            Err(error) => Response::error(error),
        },
    }
}

/// Return `(hex public key, nextSeq[0..8])`, creating the seed on first use.
pub fn identity_with(store: &mut impl SecretStore) -> Result<(String, [u64; SLOT_COUNT]), String> {
    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let pubkey = hex::encode(signing_key.verifying_key().to_bytes());

    let mut next_seq = [1u64; SLOT_COUNT];
    for (slot, value) in next_seq.iter_mut().enumerate() {
        *value = read_next_seq(store, slot as u8)?;
    }

    Ok((pubkey, next_seq))
}

/// Validate, sign, then advance the slot's sequence counter.
///
/// Ordering matters: the counter is written only after a successful signature,
/// and a failed write is an error rather than a silently issued signature that
/// could be replayed on the next call.
pub fn sign_with(
    store: &mut impl SecretStore,
    slot: u8,
    seq: u64,
    entry: Option<&Entry>,
) -> Result<String, String> {
    let slot_index = usize::from(slot);
    if slot_index >= SLOT_COUNT {
        return Err(format!(
            "slot {slot} is out of range; must be 0..{}",
            SLOT_COUNT - 1
        ));
    }
    if seq == 0 {
        return Err("seq must be greater than 0".into());
    }
    let next_seq = read_next_seq(store, slot)?;
    if seq < next_seq {
        return Err(format!(
            "stale seq {seq} for slot {slot}; need at least {next_seq}"
        ));
    }
    let following = seq
        .checked_add(1)
        .ok_or_else(|| format!("seq {seq} is too large to advance"))?;
    if let Some(entry) = entry {
        if let Some(error) = entry.metadata_error() {
            return Err(error);
        }
    }

    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(&signing_bytes(slot, seq, entry));

    if !store.set_secret(&next_seq_key(slot), &following.to_le_bytes()) {
        return Err(format!("failed to persist nextSeq for slot {slot}"));
    }

    Ok(hex::encode(signature.to_bytes()))
}

/// Build the canonical signing bytes from `DESIGN.md` §2.
///
/// This is the single implementation of the format inside this crate; the
/// contract crate must build byte-identical input. Null and absent optional
/// strings both encode as length 0.
pub fn signing_bytes(slot: u8, seq: u64, entry: Option<&Entry>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(128);
    bytes.extend_from_slice(SIGNING_DOMAIN);
    bytes.push(slot);
    bytes.extend_from_slice(&seq.to_le_bytes());

    match entry {
        None => bytes.push(0),
        Some(entry) => {
            bytes.push(1);
            bytes.extend_from_slice(&entry.value.to_le_bytes());
            push_optional_str(&mut bytes, entry.label.as_deref());
            push_optional_str(&mut bytes, entry.unit.as_deref());
            push_optional_str(&mut bytes, entry.note.as_deref());
        }
    }

    bytes
}

fn push_optional_str(bytes: &mut Vec<u8>, value: Option<&str>) {
    let value = value.unwrap_or("").as_bytes();
    // Bounds are checked before signing; the cast is lossless for every
    // accepted entry (the largest bound is 512 bytes).
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value);
}

fn next_seq_key(slot: u8) -> Vec<u8> {
    format!("{NEXTSEQ_PREFIX}{slot}").into_bytes()
}

fn read_next_seq(store: &impl SecretStore, slot: u8) -> Result<u64, String> {
    match store.get_secret(&next_seq_key(slot)) {
        None => Ok(1),
        Some(bytes) => {
            let bytes: [u8; 8] = bytes.as_slice().try_into().map_err(|_| {
                format!(
                    "stored nextSeq for slot {slot} has invalid length {} (expected 8)",
                    bytes.len()
                )
            })?;
            Ok(u64::from_le_bytes(bytes))
        }
    }
}

fn load_or_create_seed(store: &mut impl SecretStore) -> Result<[u8; 32], String> {
    if let Some(bytes) = store.get_secret(SECRET_SEED) {
        return bytes.as_slice().try_into().map_err(|_| {
            format!(
                "stored seed has invalid length {} (expected 32)",
                bytes.len()
            )
        });
    }

    let generated = freenet_stdlib::rand::rand_bytes(32);
    let seed: [u8; 32] = generated
        .as_slice()
        .try_into()
        .map_err(|_| format!("rng returned {} bytes (expected 32)", generated.len()))?;

    if !store.set_secret(SECRET_SEED, &seed) {
        return Err("failed to store generated seed".into());
    }

    Ok(seed)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use proptest::prelude::*;
    use serde_json::{Value, json};

    use super::*;

    /// Golden vector: seed `[7u8; 32]`, slot 3, seq 7,
    /// `{ value: -42, label: "weight", unit: "kg", note: null }`.
    /// Changing the signing-byte format changes the signature and fails here.
    const GOLDEN_PUBKEY: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
    const GOLDEN_SIGNATURE: &str = "6734e3576e846111f6f2c7cc9e01a67adf2c56ba8d6b7b4ee4e66de41df9ecef8dcecd0ac4226161df2465d432528483539f13af5b7bc5e60a2b9df3ea48eb0d";

    #[derive(Default)]
    struct MemoryStore {
        secrets: BTreeMap<Vec<u8>, Vec<u8>>,
    }

    impl SecretStore for MemoryStore {
        fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>> {
            self.secrets.get(key).cloned()
        }

        fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool {
            self.secrets.insert(key.to_vec(), value.to_vec());
            true
        }
    }

    fn store_with_seed(seed: [u8; 32]) -> MemoryStore {
        let mut store = MemoryStore::default();
        assert!(store.set_secret(SECRET_SEED, &seed));
        store
    }

    fn webapp_origin() -> MessageOrigin {
        MessageOrigin::WebApp(ContractInstanceId::new([0x42; 32]))
    }

    fn call(store: &mut MemoryStore, payload: &[u8]) -> Value {
        let origin = webapp_origin();
        let bytes = handle_application_message(store, Some(&origin), payload);
        serde_json::from_slice(&bytes).expect("delegate response is valid JSON")
    }

    fn is_ok(value: &Value) -> bool {
        value.get("ok").and_then(Value::as_bool) == Some(true)
    }

    fn error_text(value: &Value) -> &str {
        value
            .get("error")
            .and_then(Value::as_str)
            .expect("error response has an error string")
    }

    #[test]
    fn identity_is_stable_and_defaults_next_seq_to_one() {
        let mut store = MemoryStore::default();

        let first = call(&mut store, br#"{"cmd":"identity"}"#);
        let second = call(&mut store, br#"{"cmd":"identity"}"#);

        assert!(is_ok(&first));
        assert!(is_ok(&second));
        assert_eq!(first["pubkey"], second["pubkey"]);
        assert_eq!(first["nextSeq"], json!([1, 1, 1, 1, 1, 1, 1, 1]));
        assert_eq!(
            store.secrets.get(SECRET_SEED).map(Vec::len),
            Some(32),
            "identity must persist a 32-byte seed"
        );
    }

    #[test]
    fn golden_signing_vector() {
        let mut store = store_with_seed([7u8; 32]);

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["pubkey"], GOLDEN_PUBKEY);

        let response = call(
            &mut store,
            br#"{"cmd":"sign","slot":3,"seq":7,"entry":{"value":-42,"label":"weight","unit":"kg","note":null}}"#,
        );

        assert!(is_ok(&response), "unexpected response: {response}");
        assert_eq!(response["sig"], GOLDEN_SIGNATURE);

        // Independently confirm the pinned signature verifies under the pinned
        // public key, so this test fails on drift rather than merely on a typo.
        let entry = Entry {
            value: -42,
            label: Some("weight".into()),
            unit: Some("kg".into()),
            note: None,
        };
        let verifying_key = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let signature: [u8; 64] = hex::decode(GOLDEN_SIGNATURE)
            .expect("golden signature is hex")
            .try_into()
            .expect("golden signature is 64 bytes");
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        verifying_key
            .verify_strict(&signing_bytes(3, 7, Some(&entry)), &signature)
            .expect("golden signature verifies over the canonical bytes");
    }

    #[test]
    fn seq_is_monotonic_per_slot() {
        let mut store = store_with_seed([7u8; 32]);

        let accepted = call(
            &mut store,
            br#"{"cmd":"sign","slot":3,"seq":7,"entry":null}"#,
        );
        assert!(is_ok(&accepted), "unexpected response: {accepted}");
        assert_eq!(
            store.secrets.get(&next_seq_key(3)).cloned(),
            Some(8u64.to_le_bytes().to_vec())
        );

        let replay = call(
            &mut store,
            br#"{"cmd":"sign","slot":3,"seq":7,"entry":null}"#,
        );
        assert!(!is_ok(&replay));
        assert!(error_text(&replay).contains("stale"));

        let older = call(
            &mut store,
            br#"{"cmd":"sign","slot":3,"seq":6,"entry":null}"#,
        );
        assert!(!is_ok(&older));
        assert!(error_text(&older).contains("stale"));

        let next = call(
            &mut store,
            br#"{"cmd":"sign","slot":3,"seq":8,"entry":null}"#,
        );
        assert!(is_ok(&next), "unexpected response: {next}");

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["nextSeq"], json!([1, 1, 1, 9, 1, 1, 1, 1]));
    }

    #[test]
    fn slot_seq_and_metadata_bounds_are_enforced() {
        let mut store = store_with_seed([7u8; 32]);

        let out_of_range = call(
            &mut store,
            br#"{"cmd":"sign","slot":8,"seq":1,"entry":null}"#,
        );
        assert!(!is_ok(&out_of_range));
        assert!(error_text(&out_of_range).contains("out of range"));

        let zero_seq = call(
            &mut store,
            br#"{"cmd":"sign","slot":0,"seq":0,"entry":null}"#,
        );
        assert!(!is_ok(&zero_seq));
        assert!(error_text(&zero_seq).contains("seq"));

        let over_flow = call(
            &mut store,
            br#"{"cmd":"sign","slot":0,"seq":18446744073709551615,"entry":null}"#,
        );
        assert!(!is_ok(&over_flow));
        assert!(error_text(&over_flow).contains("too large"));

        let max_entry = Entry {
            value: i64::MAX,
            label: Some("l".repeat(MAX_LABEL_BYTES)),
            unit: Some("u".repeat(MAX_UNIT_BYTES)),
            note: Some("n".repeat(MAX_NOTE_BYTES)),
        };
        assert!(sign_with(&mut store, 0, 1, Some(&max_entry)).is_ok());

        let too_long = |entry: Entry| {
            let mut fresh = store_with_seed([7u8; 32]);
            sign_with(&mut fresh, 0, 1, Some(&entry)).expect_err("metadata bound must reject")
        };

        let label_error = too_long(Entry {
            value: 0,
            label: Some("l".repeat(MAX_LABEL_BYTES + 1)),
            unit: None,
            note: None,
        });
        assert!(label_error.contains("label"));

        let unit_error = too_long(Entry {
            value: 0,
            label: None,
            unit: Some("u".repeat(MAX_UNIT_BYTES + 1)),
            note: None,
        });
        assert!(unit_error.contains("unit"));

        let note_error = too_long(Entry {
            value: 0,
            label: None,
            unit: None,
            note: Some("n".repeat(MAX_NOTE_BYTES + 1)),
        });
        assert!(note_error.contains("note"));

        // Bounds are bytes, not characters: 33 two-byte characters is 66 bytes.
        let multibyte_error = too_long(Entry {
            value: 0,
            label: Some("é".repeat(MAX_LABEL_BYTES / 2 + 1)),
            unit: None,
            note: None,
        });
        assert!(multibyte_error.contains("label"));
    }

    #[test]
    fn non_webapp_origins_are_refused_without_touching_secrets() {
        let payload = br#"{"cmd":"identity"}"#;
        let delegate =
            MessageOrigin::Delegate(DelegateKey::new([9u8; 32], CodeHash::new([8u8; 32])));

        for (label, origin) in [("missing", None), ("delegate", Some(&delegate))] {
            let mut store = MemoryStore::default();
            let bytes = handle_application_message(&mut store, origin, payload);
            let response: Value = serde_json::from_slice(&bytes).unwrap();

            assert!(!is_ok(&response), "{label} origin must be refused");
            assert!(error_text(&response).contains("refused"));
            assert!(
                store.secrets.is_empty(),
                "{label} origin must not create a seed"
            );
        }

        let mut store = MemoryStore::default();
        let origin = webapp_origin();
        let bytes = handle_application_message(&mut store, Some(&origin), payload);
        let response: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(is_ok(&response), "web app origin must be accepted");
    }

    #[test]
    fn malformed_requests_return_errors_instead_of_panicking() {
        let bodies: &[&[u8]] = &[
            b"",
            b"{",
            b"[]",
            b"null",
            br#"{"cmd":"unknown"}"#,
            br#"{"cmd":"sign","slot":"three","seq":7,"entry":null}"#,
            br#"{"cmd":"sign","slot":3,"seq":7,"entry":{"value":"not a number"}}"#,
            br#"{"cmd":"identity""#,
        ];

        for body in bodies {
            let mut store = store_with_seed([7u8; 32]);
            let response = call(&mut store, body);
            assert!(
                !is_ok(&response),
                "malformed body {:?} must be rejected, got {response}",
                String::from_utf8_lossy(body)
            );
            assert!(response.get("error").and_then(Value::as_str).is_some());
        }
    }

    #[test]
    fn corrupt_secret_lengths_are_errors_not_silent_resets() {
        let mut store = store_with_seed([7u8; 32]);
        assert!(store.set_secret(&next_seq_key(2), &[1, 2, 3]));

        let response = call(
            &mut store,
            br#"{"cmd":"sign","slot":2,"seq":1,"entry":null}"#,
        );
        assert!(!is_ok(&response));
        assert!(error_text(&response).contains("invalid length"));

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert!(!is_ok(&identity));
        assert!(error_text(&identity).contains("invalid length"));
    }

    proptest! {
        #[test]
        fn entry_json_round_trip_preserves_signing_bytes(
            value in any::<i64>(),
            label in proptest::option::of("[A-Za-z0-9 _-]{0,64}"),
            unit in proptest::option::of("[A-Za-z0-9 _-]{0,16}"),
            note in proptest::option::of("[A-Za-z0-9 _-]{0,512}"),
        ) {
            let entry = Entry { value, label, unit, note };
            let encoded = serde_json::to_vec(&entry).unwrap();
            let decoded: Entry = serde_json::from_slice(&encoded).unwrap();

            prop_assert_eq!(&entry, &decoded);
            prop_assert_eq!(
                signing_bytes(3, 7, Some(&entry)),
                signing_bytes(3, 7, Some(&decoded))
            );
        }
    }
}
