//! `number-candidate` — the candidates room of `DESIGN-candidates.md` (P4a).
//!
//! One contract instance per owner, derived from a 36-byte parameter blob
//! `b"ZCR1" || owner_vk`. The candidate room is a separate WASM from the
//! members room (`ZMR1`) so that adding this request queue cannot re-key the
//! live members rooms.
//!
//! State v1 is the members-room state plus three records:
//!
//! - a bounded request queue (`requests`), each entry signed by its requester
//!   and needing no membership;
//! - an owner-signed dismissal set (`dismissals`) that removes request ids
//!   everywhere;
//! - an owner-signed accepting flag (`config`), monotone in `seq`.
//!
//! Memberships and messages are exactly the members-room records, signed under
//! the candidate tag but reusing the room signing domains.
//!
//! Merge is a join semilattice:
//!
//! - memberships: union by `seq`, equal `seq` keeps the lexicographically
//!   greater signature, keep the newest [`MAX_MEMBERSHIPS`];
//! - messages: union by id (BLAKE3 of the raw signature), drop messages whose
//!   epoch is outside the merged membership window or whose author was not a
//!   member at that epoch, keep the newest [`MAX_MESSAGES`] by `(time, id)`;
//! - requests: union by id, drop dismissed ids, keep the newest
//!   [`MAX_REQUESTS`] by `(time, id)`;
//! - dismissals: union by id, keep the lexicographically greatest
//!   [`MAX_DISMISSALS`];
//! - config: the record with the greatest `(seq, sig)`.
//!
//! The contract never reads the host clock and never uses randomness — the
//! caller supplies `time` and the owner supplies `seq`.

use ed25519_dalek::{Signature, VerifyingKey};
use freenet_stdlib::prelude::State as HostState;
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Room-kind tag in the parameters and in every canonical signing payload.
pub const CANDIDATE_TAG: &[u8; 4] = b"ZCR1";

/// Exact length of the parameters blob: tag + raw Ed25519 owner key.
pub const PARAMETERS_LEN: usize = 36;

/// State schema version written to (and required in) every state object.
pub const STATE_VERSION: u8 = 1;

/// Owners plus eight slots, or a full members list plus one candidate.
pub const MAX_MEMBERS: usize = 9;
/// Retained membership revisions.
pub const MAX_MEMBERSHIPS: usize = 32;
/// Epoch-secret blobs per membership: empty, or one per member.
pub const MAX_SECRETS_PER_MEMBERSHIP: usize = 9;
/// Largest decoded secret blob.
pub const MAX_SECRET_BLOB_BYTES: usize = 256;
/// Retained messages.
pub const MAX_MESSAGES: usize = 200;
/// Largest decoded message body.
pub const MAX_BODY_BYTES: usize = 1024;
/// Retained requests: the bounded public queue.
pub const MAX_REQUESTS: usize = 8;
/// Longest `want_cell` string (0..=32 zone-address digits).
pub const MAX_WANT_CELL_CHARS: usize = 32;
/// Largest decoded request note.
pub const MAX_NOTE_BYTES: usize = 256;
/// Retained owner dismissals.
pub const MAX_DISMISSALS: usize = 64;

/// Largest message count in one incremental delta.
pub const MAX_MESSAGES_PER_DELTA: usize = 16;
/// Largest membership count in one incremental delta.
pub const MAX_MEMBERSHIPS_PER_DELTA: usize = 1;
/// Largest request count in one incremental delta.
pub const MAX_REQUESTS_PER_DELTA: usize = 8;
/// Largest dismissal count in one incremental delta.
pub const MAX_DISMISSALS_PER_DELTA: usize = 8;
/// Largest config count in one incremental delta.
pub const MAX_CONFIGS_PER_DELTA: usize = 1;

/// Hex length of a raw 32-byte key.
pub const KEY_HEX_LEN: usize = 64;
/// Hex length of a raw 64-byte signature.
pub const SIGNATURE_HEX_LEN: usize = 128;
/// Hex length of a derived 16-byte request id / state digest.
pub const DIGEST_HEX_LEN: usize = 32;

/// Domain prefix of the canonical membership signing bytes (reused from the
/// members room with the candidate tag).
pub const SIGNING_DOMAIN_MEMBERSHIP: &[u8] = b"number:v1:room:membership";
/// Domain prefix of the canonical message signing bytes (reused from the
/// members room with the candidate tag).
pub const SIGNING_DOMAIN_MESSAGE: &[u8] = b"number:v1:room:message";
/// Domain prefix of the canonical request signing bytes.
pub const SIGNING_DOMAIN_REQUEST: &[u8] = b"number:v1:candidate:request";
/// Domain prefix of the canonical dismissal signing bytes.
pub const SIGNING_DOMAIN_DISMISS: &[u8] = b"number:v1:candidate:dismiss";
/// Domain prefix of the canonical config signing bytes.
pub const SIGNING_DOMAIN_CONFIG: &[u8] = b"number:v1:candidate:config";

/// Extract the owner key from the parameters.
///
/// Requires exactly [`PARAMETERS_LEN`] bytes, starting with [`CANDIDATE_TAG`]
/// and ending with a valid Ed25519 verifying key. `ZMR1` is rejected here; the
/// members room is a different room kind with its own WASM.
pub fn owner_key(parameters: &Parameters<'_>) -> Result<VerifyingKey, ContractError> {
    let bytes = parameters.as_ref();
    if bytes.len() != PARAMETERS_LEN {
        return Err(ContractError::Other(
            "candidate parameters must be exactly 36 bytes".into(),
        ));
    }
    if &bytes[..4] != CANDIDATE_TAG {
        return Err(ContractError::Other(
            "candidate parameters must start with ZCR1".into(),
        ));
    }
    let key: [u8; 32] = bytes[4..]
        .try_into()
        .map_err(|_| ContractError::Other("candidate owner key must be 32 bytes".into()))?;
    VerifyingKey::from_bytes(&key)
        .map_err(|_| ContractError::Other("candidate parameters are not an Ed25519 point".into()))
}

/// Whether `value` is exactly `len` lowercase hexadecimal characters.
fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Decode a non-empty, even-length lowercase hexadecimal string.
fn decode_lower_hex(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() {
        return None;
    }
    decode_lower_hex_allow_empty(value)
}

/// Decode an even-length lowercase hexadecimal string. The empty string decodes
/// to zero bytes; request notes are allowed to be empty.
fn decode_lower_hex_allow_empty(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    hex::decode(value).ok()
}

/// Parse a 64-hex-character public key.
fn parse_key(value: &str) -> Option<VerifyingKey> {
    if !is_lower_hex(value, KEY_HEX_LEN) {
        return None;
    }
    let bytes: [u8; 32] = hex::decode(value).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// Parse a 128-hex-character Ed25519 signature.
fn parse_signature(value: &str) -> Option<Signature> {
    if !is_lower_hex(value, SIGNATURE_HEX_LEN) {
        return None;
    }
    let bytes: [u8; 64] = hex::decode(value).ok()?.try_into().ok()?;
    Some(Signature::from_bytes(&bytes))
}

/// Decode a signature into raw bytes, mapping malformed input to all zeros.
/// Callers validate before deriving an id or merging.
fn signature_raw(value: &str) -> [u8; 64] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 64])
}

/// Decode a 64-hex-character key into raw bytes, mapping malformed input to all
/// zeros. Callers validate before signing or verifying.
fn key_raw(value: &str) -> [u8; 32] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 32])
}

/// Decode a 32-hex-character request id into raw bytes, mapping malformed input
/// to all zeros. Callers validate before verifying.
fn request_id_raw(value: &str) -> [u8; 16] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 16])
}

fn digest16(bytes: &[u8]) -> [u8; 16] {
    let hash = blake3::hash(bytes);
    let mut digest = [0u8; 16];
    digest.copy_from_slice(&hash.as_bytes()[..16]);
    digest
}

/// One wrapped epoch key for one member.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Secret {
    /// Member public key (64 lowercase hex characters).
    pub recipient: String,
    /// Opaque encrypted blob (1..=256 decoded bytes, lowercase hex).
    pub blob: String,
}

/// One owner-signed membership revision. `seq` is both the revision and the
/// epoch name.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Membership {
    /// Revision/epoch, always `> 0`.
    pub seq: u64,
    /// Strictly ascending, duplicate-free member keys, including the owner.
    pub members: Vec<String>,
    /// Empty, or exactly one blob per member in ascending member order.
    pub secrets: Vec<Secret>,
    /// Owner signature over the canonical membership bytes (128 lowercase hex).
    pub sig: String,
}

impl Membership {
    /// Whether every field is within bounds, members are ordered, the owner is
    /// present, secrets match the member set and the signature verifies under
    /// the parameter owner key.
    pub fn is_valid(&self, owner: &VerifyingKey) -> bool {
        if self.seq == 0 || self.members.is_empty() || self.members.len() > MAX_MEMBERS {
            return false;
        }
        for (index, member) in self.members.iter().enumerate() {
            if parse_key(member).is_none() {
                return false;
            }
            if index > 0 && self.members[index - 1].as_str() >= member.as_str() {
                return false;
            }
        }
        let owner_hex = hex::encode(owner.to_bytes());
        if !self.members.iter().any(|member| member == &owner_hex) {
            return false;
        }
        if !self.secrets.is_empty() {
            if self.secrets.len() != self.members.len() {
                return false;
            }
            for (secret, member) in self.secrets.iter().zip(self.members.iter()) {
                if secret.recipient != *member {
                    return false;
                }
                let Some(blob) = decode_lower_hex(&secret.blob) else {
                    return false;
                };
                if blob.is_empty() || blob.len() > MAX_SECRET_BLOB_BYTES {
                    return false;
                }
            }
        }
        let Some(signature) = parse_signature(&self.sig) else {
            return false;
        };
        owner
            .verify_strict(&membership_signing_bytes(owner, self), &signature)
            .is_ok()
    }
}

/// One author-signed message. `body` is opaque (plaintext or ciphertext).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Message {
    /// Author public key (64 lowercase hex characters).
    pub author: String,
    /// Membership epoch the message belongs to, always `> 0`.
    pub epoch: u64,
    /// Author-assigned per-author sequence, always `> 0`.
    pub seq: u64,
    /// Author-supplied milliseconds; orders display and eviction only.
    pub time: i64,
    /// Opaque body, 1..=1024 decoded bytes, lowercase hex.
    pub body: String,
    /// Author signature over the canonical message bytes (128 lowercase hex).
    pub sig: String,
}

impl Message {
    /// Derived id: `lowercase_hex(BLAKE3(raw_sig)[0..16])`. Never stored.
    pub fn id(&self) -> String {
        hex::encode(digest16(&signature_raw(&self.sig)))
    }

    /// Whether the fields are within bounds and the signature verifies under
    /// `author`. Deliberately does not check epoch membership; that needs the
    /// membership history.
    pub fn is_valid(&self, owner: &VerifyingKey) -> bool {
        if self.epoch == 0 || self.seq == 0 {
            return false;
        }
        let Some(author) = parse_key(&self.author) else {
            return false;
        };
        let Some(body) = decode_lower_hex(&self.body) else {
            return false;
        };
        if body.is_empty() || body.len() > MAX_BODY_BYTES {
            return false;
        }
        let Some(signature) = parse_signature(&self.sig) else {
            return false;
        };
        author
            .verify_strict(&message_signing_bytes(owner, self), &signature)
            .is_ok()
    }
}

/// One requester-signed queue entry. The requester need not be a member.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    /// Requester public key (64 lowercase hex characters).
    pub requester: String,
    /// Deepest zone-address cell, 0..=32 characters from `0`..=`7`; empty is
    /// the world.
    pub want_cell: String,
    /// Requester-supplied milliseconds; orders display and eviction only.
    pub time: i64,
    /// Opaque note, 0..=256 decoded bytes, lowercase hex.
    pub note: String,
    /// Requester signature over the canonical request bytes (128 lowercase
    /// hex).
    pub sig: String,
}

impl Request {
    /// Derived id: `lowercase_hex(BLAKE3(raw_sig)[0..16])`. Never stored, so a
    /// replayed request keeps the same id.
    pub fn id(&self) -> String {
        hex::encode(digest16(&signature_raw(&self.sig)))
    }

    /// Whether the fields are within bounds and the signature verifies under
    /// `requester`. No membership is required.
    pub fn is_valid(&self, owner: &VerifyingKey) -> bool {
        let Some(requester) = parse_key(&self.requester) else {
            return false;
        };
        if !valid_want_cell(&self.want_cell) {
            return false;
        }
        let Some(note) = decode_lower_hex_allow_empty(&self.note) else {
            return false;
        };
        if note.len() > MAX_NOTE_BYTES {
            return false;
        }
        let Some(signature) = parse_signature(&self.sig) else {
            return false;
        };
        requester
            .verify_strict(&request_signing_bytes(owner, self), &signature)
            .is_ok()
    }
}

/// Whether `want_cell` is at most [`MAX_WANT_CELL_CHARS`] zone-address digits.
fn valid_want_cell(value: &str) -> bool {
    value.len() <= MAX_WANT_CELL_CHARS && value.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
}

/// One owner-signed request dismissal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Dismissal {
    /// Derived request id (32 lowercase hex characters).
    pub id: String,
    /// Owner signature over the canonical dismissal bytes (128 lowercase hex).
    pub sig: String,
}

impl Dismissal {
    /// Whether the id is well formed and the signature verifies under `owner`.
    pub fn is_valid(&self, owner: &VerifyingKey) -> bool {
        if !is_lower_hex(&self.id, DIGEST_HEX_LEN) {
            return false;
        }
        let Some(signature) = parse_signature(&self.sig) else {
            return false;
        };
        owner
            .verify_strict(&dismissal_signing_bytes(owner, &self.id), &signature)
            .is_ok()
    }
}

/// One owner-signed accepting flag. `seq` is monotone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Monotone sequence, always `> 0`.
    pub seq: u64,
    /// The owner's zone-open flag.
    pub accepting: bool,
    /// Owner signature over the canonical config bytes (128 lowercase hex).
    pub sig: String,
}

impl Config {
    /// Whether `seq > 0` and the signature verifies under `owner`.
    pub fn is_valid(&self, owner: &VerifyingKey) -> bool {
        if self.seq == 0 {
            return false;
        }
        let Some(signature) = parse_signature(&self.sig) else {
            return false;
        };
        owner
            .verify_strict(&config_signing_bytes(owner, self), &signature)
            .is_ok()
    }
}

/// Full candidate-room state v1.
///
/// `config` is a required field: a state object without it is invalid. The
/// initial state carries `"config": null`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub v: u8,
    pub memberships: Vec<Membership>,
    pub messages: Vec<Message>,
    pub requests: Vec<Request>,
    pub dismissals: Vec<Dismissal>,
    pub config: Option<Config>,
}

impl<'de> Deserialize<'de> for State {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Repr {
            v: u8,
            memberships: Vec<Membership>,
            messages: Vec<Message>,
            requests: Vec<Request>,
            dismissals: Vec<Dismissal>,
            config: Option<Config>,
        }

        // `Option<Config>` alone cannot tell a missing field from `null`, and
        // the schema requires the field to be present. Inspect the object
        // before decoding the typed record.
        let value = serde_json::Value::deserialize(deserializer)?;
        let Some(object) = value.as_object() else {
            return Err(serde::de::Error::custom("state must be a JSON object"));
        };
        if !object.contains_key("config") {
            return Err(serde::de::Error::missing_field("config"));
        }
        let repr: Repr = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self {
            v: repr.v,
            memberships: repr.memberships,
            messages: repr.messages,
            requests: repr.requests,
            dismissals: repr.dismissals,
            config: repr.config,
        })
    }
}

impl State {
    /// The shared initial state, valid for every owner.
    pub fn empty() -> Self {
        Self {
            v: STATE_VERSION,
            memberships: Vec::new(),
            messages: Vec::new(),
            requests: Vec::new(),
            dismissals: Vec::new(),
            config: None,
        }
    }

    /// Decode canonical JSON state bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, ContractError> {
        serde_json::from_slice(bytes).map_err(|_| ContractError::InvalidState)
    }

    /// Encode state deterministically as compact JSON.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("State serialization cannot fail")
    }

    /// The membership record for `epoch`, if retained.
    pub fn membership(&self, epoch: u64) -> Option<&Membership> {
        self.memberships.iter().find(|record| record.seq == epoch)
    }

    /// Whether `author` was a member at `epoch`.
    pub fn is_member_at(&self, epoch: u64, author: &str) -> bool {
        self.membership(epoch)
            .is_some_and(|record| record.members.iter().any(|member| member == author))
    }

    /// Validate the version, bounds, ordering, uniqueness, epoch membership,
    /// request signatures and dismissals, and every signature under `owner`.
    pub fn validate(&self, owner: &VerifyingKey) -> Result<(), ContractError> {
        if self.v != STATE_VERSION
            || self.memberships.len() > MAX_MEMBERSHIPS
            || self.messages.len() > MAX_MESSAGES
            || self.requests.len() > MAX_REQUESTS
            || self.dismissals.len() > MAX_DISMISSALS
        {
            return Err(ContractError::InvalidState);
        }
        for (index, record) in self.memberships.iter().enumerate() {
            if !record.is_valid(owner) {
                return Err(ContractError::InvalidState);
            }
            // Strictly ascending seq: rejects duplicates and reordering.
            if index > 0 && self.memberships[index - 1].seq >= record.seq {
                return Err(ContractError::InvalidState);
            }
        }
        if !self.messages.is_empty() && self.memberships.is_empty() {
            return Err(ContractError::InvalidState);
        }
        for (index, message) in self.messages.iter().enumerate() {
            if !message.is_valid(owner) || !self.is_member_at(message.epoch, &message.author) {
                return Err(ContractError::InvalidState);
            }
            if index > 0 {
                let previous = &self.messages[index - 1];
                let previous_key = (previous.time, previous.id());
                if previous_key >= (message.time, message.id()) {
                    return Err(ContractError::InvalidState);
                }
            }
        }
        let dismissed: BTreeSet<&str> = self
            .dismissals
            .iter()
            .map(|dismissal| dismissal.id.as_str())
            .collect();
        for (index, request) in self.requests.iter().enumerate() {
            if !request.is_valid(owner) || dismissed.contains(request.id().as_str()) {
                return Err(ContractError::InvalidState);
            }
            if index > 0 {
                let previous = &self.requests[index - 1];
                let previous_key = (previous.time, previous.id());
                if previous_key >= (request.time, request.id()) {
                    return Err(ContractError::InvalidState);
                }
            }
        }
        for (index, dismissal) in self.dismissals.iter().enumerate() {
            if !dismissal.is_valid(owner) {
                return Err(ContractError::InvalidState);
            }
            if index > 0 && self.dismissals[index - 1].id >= dismissal.id {
                return Err(ContractError::InvalidState);
            }
        }
        if let Some(config) = &self.config
            && !config.is_valid(owner)
        {
            return Err(ContractError::InvalidState);
        }
        Ok(())
    }

    /// Join-semilattice merge. See the module documentation.
    pub fn merge(&mut self, other: &Self) {
        *self = merge_states(self, other);
    }
}

/// Merge two validated states. Associative, commutative and idempotent.
pub fn merge_states(a: &State, b: &State) -> State {
    let memberships = merge_memberships(&a.memberships, &b.memberships);
    let messages = merge_messages(
        &memberships,
        a.messages
            .iter()
            .chain(b.messages.iter())
            .cloned()
            .collect(),
    );
    let dismissals = merge_dismissals(
        a.dismissals
            .iter()
            .chain(b.dismissals.iter())
            .cloned()
            .collect(),
    );
    let requests = merge_requests(
        a.requests
            .iter()
            .chain(b.requests.iter())
            .cloned()
            .collect(),
        &dismissals,
    );
    let config = merge_config(a.config.as_ref(), b.config.as_ref());
    State {
        v: STATE_VERSION,
        memberships,
        messages,
        requests,
        dismissals,
        config,
    }
}

/// Membership union by `seq`; equal `seq` keeps the lexicographically greater
/// signature bytes (lowercase hex order equals raw-byte order). Keeps the
/// newest [`MAX_MEMBERSHIPS`] revisions.
fn merge_memberships(a: &[Membership], b: &[Membership]) -> Vec<Membership> {
    let mut map: BTreeMap<u64, Membership> = BTreeMap::new();
    for record in a.iter().chain(b.iter()) {
        match map.entry(record.seq) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(record.clone());
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                if record.sig > entry.get().sig {
                    entry.insert(record.clone());
                }
            }
        }
    }
    let mut records: Vec<Membership> = map.into_values().collect();
    if records.len() > MAX_MEMBERSHIPS {
        records.drain(..records.len() - MAX_MEMBERSHIPS);
    }
    records
}

/// Message union by id, filtered against the merged membership window, sorted
/// by `(time, id)` and capped to the newest [`MAX_MESSAGES`].
///
/// Input messages are assumed to be individually valid (signature checked by
/// the caller or by the state validator); this function applies the
/// history-dependent rules only.
fn merge_messages(memberships: &[Membership], messages: Vec<Message>) -> Vec<Message> {
    let mut map: BTreeMap<String, Message> = BTreeMap::new();
    for message in messages {
        let Some(record) = memberships
            .iter()
            .find(|record| record.seq == message.epoch)
        else {
            continue;
        };
        if !record
            .members
            .iter()
            .any(|member| member == &message.author)
        {
            continue;
        }
        map.entry(message.id()).or_insert(message);
    }
    let mut messages: Vec<Message> = map.into_values().collect();
    messages.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
    if messages.len() > MAX_MESSAGES {
        messages.drain(..messages.len() - MAX_MESSAGES);
    }
    messages
}

/// Request union by id, dropping dismissed ids, sorted by `(time, id)` and
/// capped to the newest [`MAX_REQUESTS`].
fn merge_requests(requests: Vec<Request>, dismissals: &[Dismissal]) -> Vec<Request> {
    let dismissed: BTreeSet<&str> = dismissals
        .iter()
        .map(|dismissal| dismissal.id.as_str())
        .collect();
    let mut map: BTreeMap<String, Request> = BTreeMap::new();
    for request in requests {
        let id = request.id();
        if dismissed.contains(id.as_str()) {
            continue;
        }
        map.entry(id).or_insert(request);
    }
    let mut requests: Vec<Request> = map.into_values().collect();
    requests.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
    if requests.len() > MAX_REQUESTS {
        requests.drain(..requests.len() - MAX_REQUESTS);
    }
    requests
}

/// Dismissal union by id, ascending, keeping the lexicographically greatest
/// [`MAX_DISMISSALS`].
fn merge_dismissals(dismissals: Vec<Dismissal>) -> Vec<Dismissal> {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for dismissal in dismissals {
        match map.entry(dismissal.id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(dismissal.sig);
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                if dismissal.sig > *entry.get() {
                    entry.insert(dismissal.sig);
                }
            }
        }
    }
    let mut dismissals: Vec<Dismissal> = map
        .into_iter()
        .map(|(id, sig)| Dismissal { id, sig })
        .collect();
    if dismissals.len() > MAX_DISMISSALS {
        dismissals.drain(..dismissals.len() - MAX_DISMISSALS);
    }
    dismissals
}

/// Keep the config with the greatest `(seq, sig)`; `None` is the identity.
fn merge_config(a: Option<&Config>, b: Option<&Config>) -> Option<Config> {
    match (a, b) {
        (None, None) => None,
        (Some(config), None) | (None, Some(config)) => Some(config.clone()),
        (Some(a), Some(b)) => Some(if config_greater(a, b) {
            a.clone()
        } else {
            b.clone()
        }),
    }
}

/// Whether `a` wins over `b`: greater `seq`, then greater signature bytes.
fn config_greater(a: &Config, b: &Config) -> bool {
    (a.seq, &a.sig) > (b.seq, &b.sig)
}

/// Canonical membership signing bytes, tag `ZCR1`:
///
/// ```text
/// b"number:v1:room:membership"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || seq: u64 LE
/// || member_count: u16 LE
/// || each member ascending: 32 bytes
/// || secret_count: u16 LE
/// || each secret ascending by recipient:
///      recipient: 32 bytes || blob_len: u32 LE || blob
/// ```
pub fn membership_signing_bytes(owner: &VerifyingKey, record: &Membership) -> Vec<u8> {
    membership_signing_bytes_with_tag(CANDIDATE_TAG, owner, record)
}

fn membership_signing_bytes_with_tag(
    tag: &[u8; 4],
    owner: &VerifyingKey,
    record: &Membership,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 + record.members.len() * 32);
    out.extend_from_slice(SIGNING_DOMAIN_MEMBERSHIP);
    out.extend_from_slice(tag);
    out.extend_from_slice(&owner.to_bytes());
    out.extend_from_slice(&record.seq.to_le_bytes());
    let member_count =
        u16::try_from(record.members.len()).expect("member count is bounded by MAX_MEMBERS");
    out.extend_from_slice(&member_count.to_le_bytes());
    for member in &record.members {
        out.extend_from_slice(&key_raw(member));
    }
    let secret_count = u16::try_from(record.secrets.len())
        .expect("secret count is bounded by MAX_SECRETS_PER_MEMBERSHIP");
    out.extend_from_slice(&secret_count.to_le_bytes());
    for secret in &record.secrets {
        out.extend_from_slice(&key_raw(&secret.recipient));
        let blob = decode_lower_hex(&secret.blob).unwrap_or_default();
        let blob_len =
            u32::try_from(blob.len()).expect("secret bounds keep lengths below u32::MAX");
        out.extend_from_slice(&blob_len.to_le_bytes());
        out.extend_from_slice(&blob);
    }
    out
}

/// Canonical message signing bytes, tag `ZCR1`:
///
/// ```text
/// b"number:v1:room:message"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || author: 32 bytes
/// || epoch: u64 LE
/// || seq: u64 LE
/// || time: i64 LE
/// || body_len: u32 LE
/// || body
/// ```
pub fn message_signing_bytes(owner: &VerifyingKey, message: &Message) -> Vec<u8> {
    message_signing_bytes_with_tag(CANDIDATE_TAG, owner, message)
}

fn message_signing_bytes_with_tag(
    tag: &[u8; 4],
    owner: &VerifyingKey,
    message: &Message,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(SIGNING_DOMAIN_MESSAGE);
    out.extend_from_slice(tag);
    out.extend_from_slice(&owner.to_bytes());
    out.extend_from_slice(&key_raw(&message.author));
    out.extend_from_slice(&message.epoch.to_le_bytes());
    out.extend_from_slice(&message.seq.to_le_bytes());
    out.extend_from_slice(&message.time.to_le_bytes());
    let body = decode_lower_hex(&message.body).unwrap_or_default();
    let body_len = u32::try_from(body.len()).expect("body bounds keep lengths below u32::MAX");
    out.extend_from_slice(&body_len.to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Canonical request signing bytes (`DESIGN-candidates.md` §3):
///
/// ```text
/// b"number:v1:candidate:request"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || requester: 32 bytes
/// || time: i64 LE
/// || want_cell_len: u16 LE
/// || want_cell: ASCII digits             // 0..=32 bytes
/// || note_len: u32 LE
/// || note                                // 0..=256 bytes
/// ```
pub fn request_signing_bytes(owner: &VerifyingKey, request: &Request) -> Vec<u8> {
    request_signing_bytes_with_tag(CANDIDATE_TAG, owner, request)
}

fn request_signing_bytes_with_tag(
    tag: &[u8; 4],
    owner: &VerifyingKey,
    request: &Request,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(SIGNING_DOMAIN_REQUEST);
    out.extend_from_slice(tag);
    out.extend_from_slice(&owner.to_bytes());
    out.extend_from_slice(&key_raw(&request.requester));
    out.extend_from_slice(&request.time.to_le_bytes());
    let want_cell_len = u16::try_from(request.want_cell.len())
        .expect("want_cell length is bounded by MAX_WANT_CELL_CHARS");
    out.extend_from_slice(&want_cell_len.to_le_bytes());
    out.extend_from_slice(request.want_cell.as_bytes());
    let note = decode_lower_hex_allow_empty(&request.note).unwrap_or_default();
    let note_len = u32::try_from(note.len()).expect("note bounds keep lengths below u32::MAX");
    out.extend_from_slice(&note_len.to_le_bytes());
    out.extend_from_slice(&note);
    out
}

/// Canonical dismissal signing bytes (`DESIGN-candidates.md` §3):
///
/// ```text
/// b"number:v1:candidate:dismiss"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || request_id: 16 bytes
/// ```
pub fn dismissal_signing_bytes(owner: &VerifyingKey, id: &str) -> Vec<u8> {
    dismissal_signing_bytes_with_tag(CANDIDATE_TAG, owner, id)
}

fn dismissal_signing_bytes_with_tag(tag: &[u8; 4], owner: &VerifyingKey, id: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(SIGNING_DOMAIN_DISMISS);
    out.extend_from_slice(tag);
    out.extend_from_slice(&owner.to_bytes());
    out.extend_from_slice(&request_id_raw(id));
    out
}

/// Canonical config signing bytes (`DESIGN-candidates.md` §3):
///
/// ```text
/// b"number:v1:candidate:config"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || seq: u64 LE
/// || accepting: u8                      // 0 or 1
/// ```
pub fn config_signing_bytes(owner: &VerifyingKey, config: &Config) -> Vec<u8> {
    config_signing_bytes_with_tag(CANDIDATE_TAG, owner, config)
}

fn config_signing_bytes_with_tag(tag: &[u8; 4], owner: &VerifyingKey, config: &Config) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(SIGNING_DOMAIN_CONFIG);
    out.extend_from_slice(tag);
    out.extend_from_slice(&owner.to_bytes());
    out.extend_from_slice(&config.seq.to_le_bytes());
    out.push(u8::from(config.accepting));
    out
}

/// Digest of the canonical state bytes: `BLAKE3(bytes)[0..16]` as 32 lowercase
/// hex characters.
pub fn state_digest(state: &State) -> String {
    hex::encode(digest16(&state.to_bytes()))
}

/// State summary `{ "v": 1, "digest": "<32 hex>" }`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Summary {
    pub v: u8,
    pub digest: String,
}

impl Summary {
    /// Build the summary for `state`.
    pub fn of(state: &State) -> Self {
        Self {
            v: STATE_VERSION,
            digest: state_digest(state),
        }
    }

    /// Encode deterministically as JSON.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Summary serialization cannot fail")
    }

    /// Decode and structurally validate summary bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, ContractError> {
        let summary: Self =
            serde_json::from_slice(bytes).map_err(|_| ContractError::InvalidDelta)?;
        if summary.v != STATE_VERSION || !is_lower_hex(&summary.digest, DIGEST_HEX_LEN) {
            return Err(ContractError::InvalidDelta);
        }
        Ok(summary)
    }
}

/// An incoming update: either the whole state (catch-up path) or an incremental
/// delta carrying at most one membership, sixteen messages, eight requests,
/// eight dismissals and one config.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Delta {
    pub v: u8,
    /// Full state catch-up. Mutually exclusive with the incremental fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full: Option<State>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memberships: Vec<Membership>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requests: Vec<Request>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dismissals: Vec<Dismissal>,
    /// Absent means "no config change".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Config>,
}

impl Delta {
    /// Encode deterministically as JSON.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Delta serialization cannot fail")
    }

    /// Decode JSON delta bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, ContractError> {
        serde_json::from_slice(bytes).map_err(|_| ContractError::InvalidDelta)
    }

    /// Structural validation, independent of the current state. Caps are
    /// checked before any signature loop.
    fn staged(&self, owner: &VerifyingKey) -> Result<Staged, ContractError> {
        if self.v != STATE_VERSION {
            return Err(ContractError::InvalidDelta);
        }
        if let Some(full) = &self.full {
            if !self.memberships.is_empty()
                || !self.messages.is_empty()
                || !self.requests.is_empty()
                || !self.dismissals.is_empty()
                || self.config.is_some()
            {
                return Err(ContractError::InvalidDelta);
            }
            full.validate(owner)?;
            return Ok(Staged::Full(Box::new(full.clone())));
        }
        if self.memberships.len() > MAX_MEMBERSHIPS_PER_DELTA
            || self.messages.len() > MAX_MESSAGES_PER_DELTA
            || self.requests.len() > MAX_REQUESTS_PER_DELTA
            || self.dismissals.len() > MAX_DISMISSALS_PER_DELTA
        {
            return Err(ContractError::InvalidDelta);
        }
        for record in &self.memberships {
            if !record.is_valid(owner) {
                return Err(ContractError::InvalidDelta);
            }
        }
        for request in &self.requests {
            if !request.is_valid(owner) {
                return Err(ContractError::InvalidDelta);
            }
        }
        for dismissal in &self.dismissals {
            if !dismissal.is_valid(owner) {
                return Err(ContractError::InvalidDelta);
            }
        }
        if let Some(config) = &self.config
            && !config.is_valid(owner)
        {
            return Err(ContractError::InvalidDelta);
        }
        Ok(Staged::Incremental {
            memberships: self.memberships.clone(),
            messages: self.messages.clone(),
            requests: self.requests.clone(),
            dismissals: self.dismissals.clone(),
            config: self.config.clone(),
        })
    }
}

/// A structurally validated incoming update.
enum Staged {
    Full(Box<State>),
    Incremental {
        memberships: Vec<Membership>,
        messages: Vec<Message>,
        requests: Vec<Request>,
        dismissals: Vec<Dismissal>,
        config: Option<Config>,
    },
}

/// The candidate-room contract.
pub struct CandidateContract;

#[contract]
impl ContractInterface for CandidateContract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: HostState<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let Ok(owner) = owner_key(&parameters) else {
            return Ok(ValidateResult::Invalid);
        };
        let Ok(state) = State::decode(state.as_ref()) else {
            return Ok(ValidateResult::Invalid);
        };
        match state.validate(&owner) {
            Ok(()) => Ok(ValidateResult::Valid),
            Err(_) => Ok(ValidateResult::Invalid),
        }
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: HostState<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let owner = owner_key(&parameters)?;
        let current = State::decode(state.as_ref())?;
        current.validate(&owner)?;

        // Stage every incoming update independently. Invalid updates are
        // skipped: rooms are multi-writer, so one malformed delta must not block
        // a valid one. Only a bad parameter blob or a bad current state is fatal.
        let mut staged = Vec::new();
        for item in &data {
            match item {
                UpdateData::State(incoming) => {
                    if let Ok(incoming) = State::decode(incoming.as_ref())
                        && incoming.validate(&owner).is_ok()
                    {
                        staged.push(Staged::Full(Box::new(incoming)));
                    }
                }
                UpdateData::Delta(delta) => {
                    if let Ok(delta) = Delta::decode(delta.as_ref())
                        && let Ok(staged_delta) = delta.staged(&owner)
                    {
                        staged.push(staged_delta);
                    }
                }
                UpdateData::StateAndDelta {
                    state: incoming,
                    delta,
                } => {
                    if let Ok(incoming) = State::decode(incoming.as_ref())
                        && incoming.validate(&owner).is_ok()
                    {
                        staged.push(Staged::Full(Box::new(incoming)));
                    }
                    if let Ok(delta) = Delta::decode(delta.as_ref())
                        && let Ok(staged_delta) = delta.staged(&owner)
                    {
                        staged.push(staged_delta);
                    }
                }
                // Related contracts are not part of this design.
                _ => {}
            }
        }

        // Two-phase application: merge every valid membership first, then
        // validate/collect messages against the merged epoch history. Requests,
        // dismissals and config merge independently; dismissals and config are
        // applied before the request filter.
        let mut memberships = current.memberships.clone();
        let mut messages = current.messages.clone();
        let mut requests = current.requests.clone();
        let mut dismissals = current.dismissals.clone();
        let mut config = current.config.clone();
        for item in staged {
            match item {
                Staged::Full(incoming) => {
                    memberships = merge_memberships(&memberships, &incoming.memberships);
                    messages.extend(incoming.messages);
                    requests.extend(incoming.requests);
                    dismissals.extend(incoming.dismissals);
                    config = merge_config(config.as_ref(), incoming.config.as_ref());
                }
                Staged::Incremental {
                    memberships: incoming_memberships,
                    messages: incoming_messages,
                    requests: incoming_requests,
                    dismissals: incoming_dismissals,
                    config: incoming_config,
                } => {
                    memberships = merge_memberships(&memberships, &incoming_memberships);
                    for message in incoming_messages {
                        if message.is_valid(&owner) {
                            messages.push(message);
                        }
                    }
                    requests.extend(incoming_requests);
                    dismissals.extend(incoming_dismissals);
                    config = merge_config(config.as_ref(), incoming_config.as_ref());
                }
            }
        }
        let messages = merge_messages(&memberships, messages);
        let dismissals = merge_dismissals(dismissals);
        let requests = merge_requests(requests, &dismissals);
        let result = State {
            v: STATE_VERSION,
            memberships,
            messages,
            requests,
            dismissals,
            config,
        };
        Ok(UpdateModification::valid(HostState::from(
            result.to_bytes(),
        )))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: HostState<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let state = State::decode(state.as_ref())?;
        Ok(StateSummary::from(Summary::of(&state).to_bytes()))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: HostState<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = State::decode(state.as_ref())?;
        // An empty summary is a brand-new subscriber. An undecodable summary is
        // treated the same way (send the full state) rather than aborting a
        // subscription.
        let summary = if summary.as_ref().is_empty() {
            None
        } else {
            Summary::decode(summary.as_ref()).ok()
        };
        let converged = summary
            .as_ref()
            .is_some_and(|summary| summary.digest == state_digest(&state));
        if converged {
            return Ok(StateDelta::from(Vec::new()));
        }
        let delta = Delta {
            v: STATE_VERSION,
            full: Some(state),
            memberships: Vec::new(),
            messages: Vec::new(),
            requests: Vec::new(),
            dismissals: Vec::new(),
            config: None,
        };
        Ok(StateDelta::from(delta.to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use proptest::prelude::*;
    use std::collections::HashSet;

    const GOLDEN: &str = include_str!("../../fixtures/candidate/golden_v1.json");

    fn test_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn owner() -> SigningKey {
        test_key(7)
    }

    fn member_a() -> SigningKey {
        test_key(11)
    }

    fn member_b() -> SigningKey {
        test_key(22)
    }

    fn outsider() -> SigningKey {
        test_key(33)
    }

    fn owner_hex(signing: &SigningKey) -> String {
        hex::encode(signing.verifying_key().to_bytes())
    }

    fn params(signing: &SigningKey) -> Parameters<'static> {
        let mut bytes = Vec::with_capacity(PARAMETERS_LEN);
        bytes.extend_from_slice(CANDIDATE_TAG);
        bytes.extend_from_slice(&signing.verifying_key().to_bytes());
        Parameters::from(bytes)
    }

    fn signed_membership(owner: &SigningKey, record: &mut Membership) {
        record.sig = hex::encode(
            owner
                .sign(&membership_signing_bytes(&owner.verifying_key(), record))
                .to_bytes(),
        );
    }

    fn membership_of(owner: &SigningKey, seq: u64, members: &[&SigningKey]) -> Membership {
        let mut keys: Vec<String> = members.iter().map(|key| owner_hex(key)).collect();
        keys.sort();
        let mut record = Membership {
            seq,
            members: keys,
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(owner, &mut record);
        record
    }

    fn membership_with_secrets(
        owner: &SigningKey,
        seq: u64,
        members: &[&SigningKey],
        blobs: &[&[u8]],
    ) -> Membership {
        assert_eq!(members.len(), blobs.len());
        let mut pairs: Vec<(String, Vec<u8>)> = members
            .iter()
            .zip(blobs.iter())
            .map(|(key, blob)| (owner_hex(key), blob.to_vec()))
            .collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let keys: Vec<String> = pairs.iter().map(|(key, _)| key.clone()).collect();
        let secrets = pairs
            .into_iter()
            .map(|(recipient, blob)| Secret {
                recipient,
                blob: hex::encode(blob),
            })
            .collect();
        let mut record = Membership {
            seq,
            members: keys,
            secrets,
            sig: String::new(),
        };
        signed_membership(owner, &mut record);
        record
    }

    fn signed_message(
        owner: &SigningKey,
        author: &SigningKey,
        epoch: u64,
        seq: u64,
        time: i64,
        body: &[u8],
    ) -> Message {
        let mut message = Message {
            author: owner_hex(author),
            epoch,
            seq,
            time,
            body: hex::encode(body),
            sig: String::new(),
        };
        message.sig = hex::encode(
            author
                .sign(&message_signing_bytes(&owner.verifying_key(), &message))
                .to_bytes(),
        );
        message
    }

    fn sign_request(
        owner: &SigningKey,
        requester: &SigningKey,
        time: i64,
        want_cell: &str,
        note_hex: &str,
    ) -> Request {
        let mut request = Request {
            requester: owner_hex(requester),
            want_cell: want_cell.into(),
            time,
            note: note_hex.into(),
            sig: String::new(),
        };
        request.sig = hex::encode(
            requester
                .sign(&request_signing_bytes(&owner.verifying_key(), &request))
                .to_bytes(),
        );
        request
    }

    fn signed_request(
        owner: &SigningKey,
        requester: &SigningKey,
        time: i64,
        want_cell: &str,
        note: &[u8],
    ) -> Request {
        sign_request(owner, requester, time, want_cell, &hex::encode(note))
    }

    fn dismissal_over(owner: &SigningKey, id: &str) -> Dismissal {
        let mut dismissal = Dismissal {
            id: id.into(),
            sig: String::new(),
        };
        dismissal.sig = hex::encode(
            owner
                .sign(&dismissal_signing_bytes(
                    &owner.verifying_key(),
                    &dismissal.id,
                ))
                .to_bytes(),
        );
        dismissal
    }

    fn signed_dismissal(owner: &SigningKey, request: &Request) -> Dismissal {
        dismissal_over(owner, &request.id())
    }

    fn signed_config(owner: &SigningKey, seq: u64, accepting: bool) -> Config {
        let mut config = Config {
            seq,
            accepting,
            sig: String::new(),
        };
        config.sig = hex::encode(
            owner
                .sign(&config_signing_bytes(&owner.verifying_key(), &config))
                .to_bytes(),
        );
        config
    }

    fn sorted(mut messages: Vec<Message>) -> Vec<Message> {
        messages.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
        messages
    }

    fn state_with(
        memberships: Vec<Membership>,
        messages: Vec<Message>,
        requests: Vec<Request>,
        dismissals: Vec<Dismissal>,
        config: Option<Config>,
    ) -> State {
        let mut requests = requests;
        requests.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
        let mut dismissals = dismissals;
        dismissals.sort_by(|a, b| a.id.cmp(&b.id));
        State {
            v: STATE_VERSION,
            memberships,
            messages: sorted(messages),
            requests,
            dismissals,
            config,
        }
    }

    fn state_of(memberships: Vec<Membership>, messages: Vec<Message>) -> State {
        state_with(memberships, messages, Vec::new(), Vec::new(), None)
    }

    fn empty_delta() -> Delta {
        Delta {
            v: STATE_VERSION,
            full: None,
            memberships: Vec::new(),
            messages: Vec::new(),
            requests: Vec::new(),
            dismissals: Vec::new(),
            config: None,
        }
    }

    fn validate_state_with(owner: &SigningKey, state: &State) -> ValidateResult {
        CandidateContract::validate_state(
            params(owner),
            HostState::from(state.to_bytes()),
            RelatedContracts::default(),
        )
        .unwrap()
    }

    fn update(
        owner: &SigningKey,
        state: &State,
        data: Vec<UpdateData<'static>>,
    ) -> Result<State, ContractError> {
        let updated = CandidateContract::update_state(
            params(owner),
            HostState::from(state.to_bytes()),
            data,
        )?;
        Ok(State::decode(updated.unwrap_valid().as_ref()).unwrap())
    }

    fn delta_bytes(delta: &Delta) -> StateDelta<'static> {
        StateDelta::from(delta.to_bytes())
    }

    fn full_delta(state: &State) -> Delta {
        Delta {
            full: Some(state.clone()),
            ..empty_delta()
        }
    }

    fn merge_order(states: &[State], order: &[usize]) -> State {
        let mut result = State::empty();
        for &index in order {
            result.merge(&states[index]);
        }
        result
    }

    const ORDERS: [[usize; 3]; 6] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];

    // ---- 1. parameters and the empty state --------------------------------

    #[test]
    fn empty_initial_state_validates_for_any_owner() {
        let initial: State =
            serde_json::from_str(include_str!("../initial_state.json")).expect("initial state");
        assert_eq!(initial, State::empty());
        assert_eq!(
            validate_state_with(&owner(), &initial),
            ValidateResult::Valid
        );
        assert_eq!(
            validate_state_with(&member_a(), &initial),
            ValidateResult::Valid
        );

        // The same empty state under the members-room tag is invalid.
        let mut zmr1 = params(&owner()).as_ref().to_vec();
        zmr1[..4].copy_from_slice(b"ZMR1");
        assert_eq!(
            CandidateContract::validate_state(
                Parameters::from(zmr1),
                HostState::from(initial.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn parameters_must_be_zcr1_and_exactly_36_bytes() {
        let owner = owner();
        let good = params(&owner);
        assert_eq!(owner_key(&good).unwrap(), owner.verifying_key());

        let mut zmr1 = good.as_ref().to_vec();
        zmr1[..4].copy_from_slice(b"ZMR1");
        assert!(owner_key(&Parameters::from(zmr1)).is_err());

        for length in [0usize, 4, 35, 37, 68] {
            let mut bytes = good.as_ref().to_vec();
            bytes.resize(length, 0);
            assert!(
                owner_key(&Parameters::from(bytes)).is_err(),
                "length {length} must fail"
            );
        }

        let mut bad_point = good.as_ref().to_vec();
        bad_point[4..].fill(0x02);
        assert!(owner_key(&Parameters::from(bad_point)).is_err());
    }

    #[test]
    fn messages_without_memberships_are_invalid() {
        let owner = owner();
        let state = state_of(
            Vec::new(),
            vec![signed_message(&owner, &member_a(), 1, 1, 0, b"orphan")],
        );
        assert_eq!(validate_state_with(&owner, &state), ValidateResult::Invalid);
        assert!(state.validate(&owner.verifying_key()).is_err());
    }

    // ---- 2. membership and message tampering ------------------------------

    #[test]
    fn membership_signature_binds_every_field() {
        let owner = owner();
        let key = owner.verifying_key();
        let good = membership_of(&owner, 3, &[&owner, &member_a()]);
        assert!(good.is_valid(&key));

        let mut tampered = good.clone();
        tampered.seq = 4;
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.members = vec![owner_hex(&owner), owner_hex(&member_b())];
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.members = vec![owner_hex(&owner), owner_hex(&member_a())];
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.secrets = vec![Secret {
            recipient: owner_hex(&owner),
            blob: "01".into(),
        }];
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.sig = "00".repeat(64);
        assert!(!tampered.is_valid(&key));

        assert!(!good.is_valid(&member_b().verifying_key()));
    }

    #[test]
    fn membership_signature_binds_member_order_and_secret_bytes() {
        let owner = owner();
        let key = owner.verifying_key();
        let ascending = {
            let mut keys = vec![owner_hex(&owner), owner_hex(&member_a())];
            keys.sort();
            keys
        };
        let descending = {
            let mut keys = ascending.clone();
            keys.reverse();
            keys
        };

        let mut wrong_order = Membership {
            seq: 1,
            members: descending,
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(&owner, &mut wrong_order);
        wrong_order.members = ascending;
        assert!(!wrong_order.is_valid(&key));

        let good = membership_with_secrets(
            &owner,
            1,
            &[&owner, &member_a()],
            &[b"\x01\x02", b"\xde\xad\xbe\xef"],
        );
        assert!(good.is_valid(&key));

        let mut tampered = good.clone();
        tampered.secrets[0].blob = "0103".into();
        assert!(!tampered.is_valid(&key));

        let mut tampered = good;
        tampered.secrets[0].recipient = owner_hex(&member_b());
        assert!(!tampered.is_valid(&key));
    }

    #[test]
    fn message_signature_binds_every_field() {
        let owner = owner();
        let key = owner.verifying_key();
        let good = signed_message(&owner, &member_a(), 1, 1, 1_762_500_000_000, b"hello");
        assert!(good.is_valid(&key));

        let mutations: [fn(&mut Message); 6] = [
            |m| m.author = owner_hex(&member_b()),
            |m| m.epoch = 2,
            |m| m.seq = 2,
            |m| m.time += 1,
            |m| m.body = hex::encode(b"hellp"),
            |m| m.sig = "00".repeat(64),
        ];
        for mutate in mutations {
            let mut tampered = good.clone();
            mutate(&mut tampered);
            assert!(!tampered.is_valid(&key));
        }

        assert!(!good.is_valid(&member_b().verifying_key()));
    }

    // ---- 3. request signatures and bounds ---------------------------------

    #[test]
    fn request_signature_binds_every_field() {
        let owner = owner();
        let key = owner.verifying_key();
        let good = signed_request(&owner, &outsider(), 1_762_500_000_000, "003", b"let me in");
        assert!(good.is_valid(&key));

        let mut tampered = good.clone();
        tampered.requester = owner_hex(&member_b());
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.time += 1;
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.want_cell = "004".into();
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.note = hex::encode(b"let me out");
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.sig = "00".repeat(64);
        assert!(!tampered.is_valid(&key));

        // Cross-owner verification fails: the owner is in the payload.
        assert!(!good.is_valid(&member_b().verifying_key()));

        // A signature made under the members-room tag does not verify here.
        let tagged = {
            let mut request = good.clone();
            request.sig = hex::encode(
                outsider()
                    .sign(&request_signing_bytes_with_tag(b"ZMR1", &key, &request))
                    .to_bytes(),
            );
            request
        };
        assert!(!tagged.is_valid(&key));

        assert_eq!(good.id().len(), DIGEST_HEX_LEN);
    }

    #[test]
    fn request_bounds() {
        let owner = owner();
        let key = owner.verifying_key();
        let requester = outsider();

        // Empty note and empty want_cell are valid.
        let empty = signed_request(&owner, &requester, 0, "", b"");
        assert!(empty.is_valid(&key));

        // Exact bounds are valid; one past them is not.
        let max_cell = "0".repeat(MAX_WANT_CELL_CHARS);
        let max_note = vec![0x41u8; MAX_NOTE_BYTES];
        assert!(signed_request(&owner, &requester, 0, &max_cell, &max_note).is_valid(&key));

        let too_long_cell = "0".repeat(MAX_WANT_CELL_CHARS + 1);
        assert!(!signed_request(&owner, &requester, 0, &too_long_cell, b"x").is_valid(&key));
        assert!(!signed_request(&owner, &requester, 0, "8", b"x").is_valid(&key));
        assert!(!signed_request(&owner, &requester, 0, "a", b"x").is_valid(&key));
        assert!(!signed_request(&owner, &requester, 0, "01 2", b"x").is_valid(&key));

        let too_long_note = vec![0x41u8; MAX_NOTE_BYTES + 1];
        assert!(!signed_request(&owner, &requester, 0, "", &too_long_note).is_valid(&key));

        // Bad hex: odd length, non-hex, uppercase.
        assert!(!sign_request(&owner, &requester, 0, "", "0").is_valid(&key));
        assert!(!sign_request(&owner, &requester, 0, "", "zz").is_valid(&key));
        assert!(!sign_request(&owner, &requester, 0, "", "AB").is_valid(&key));

        // Bad key and signature.
        let mut bad_requester = empty.clone();
        bad_requester.requester = "AB".repeat(32);
        assert!(!bad_requester.is_valid(&key));
        let mut bad_sig = empty.clone();
        bad_sig.sig = "AB".repeat(64);
        assert!(!bad_sig.is_valid(&key));

        // Nine requests in one state exceed the bound.
        let requests: Vec<Request> = (0..=MAX_REQUESTS as i64)
            .map(|time| signed_request(&owner, &requester, time, "0", b"x"))
            .collect();
        assert_eq!(requests.len(), MAX_REQUESTS + 1);
        let state = state_with(Vec::new(), Vec::new(), requests, Vec::new(), None);
        assert_eq!(validate_state_with(&owner, &state), ValidateResult::Invalid);
    }

    // ---- 4. non-member queue ----------------------------------------------

    #[test]
    fn non_member_requests_are_accepted_and_queue_keeps_newest_eight() {
        let owner = owner();
        let base = State::empty();

        let first = signed_request(&owner, &member_a(), 10, "003", b"first");
        let second = signed_request(&owner, &member_b(), 20, "", b"second");
        let after = update(
            &owner,
            &base,
            vec![
                UpdateData::Delta(delta_bytes(&Delta {
                    requests: vec![first.clone()],
                    ..empty_delta()
                })),
                UpdateData::Delta(delta_bytes(&Delta {
                    requests: vec![second.clone()],
                    ..empty_delta()
                })),
            ],
        )
        .unwrap();
        assert_eq!(after.requests, vec![first, second]);
        assert_eq!(validate_state_with(&owner, &after), ValidateResult::Valid);

        // Ten requests with tied times; the id breaks ties.
        let requests: Vec<Request> = (0..10i64)
            .map(|index| {
                signed_request(
                    &owner,
                    &outsider(),
                    index / 2,
                    "0",
                    format!("r{index}").as_bytes(),
                )
            })
            .collect();
        let mut sorted_requests = requests.clone();
        sorted_requests.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
        let expected: Vec<String> = sorted_requests[2..]
            .iter()
            .map(|request| request.id())
            .collect();

        // Deliver in two different orders; both converge on the newest eight.
        for order in [
            [0usize, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            [9, 3, 7, 1, 5, 8, 0, 6, 2, 4],
        ] {
            let mut state = State::empty();
            for index in order {
                state = update(
                    &owner,
                    &state,
                    vec![UpdateData::Delta(delta_bytes(&Delta {
                        requests: vec![requests[index].clone()],
                        ..empty_delta()
                    }))],
                )
                .unwrap();
            }
            let ids: Vec<String> = state.requests.iter().map(|request| request.id()).collect();
            assert_eq!(ids, expected, "order {order:?}");
        }
    }

    // ---- 5. dismissals -----------------------------------------------------

    #[test]
    fn dismissal_removes_requests_and_stays_dismissed() {
        let owner = owner();
        let key = owner.verifying_key();
        let request = signed_request(&owner, &member_a(), 10, "003", b"hello");
        let other = signed_request(&owner, &member_b(), 20, "", b"other");
        let dismissal = signed_dismissal(&owner, &request);
        assert!(dismissal.is_valid(&key));

        let base = state_with(
            Vec::new(),
            Vec::new(),
            vec![request.clone(), other.clone()],
            Vec::new(),
            None,
        );
        assert_eq!(validate_state_with(&owner, &base), ValidateResult::Valid);

        let dismissed_state = state_with(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![dismissal.clone()],
            None,
        );
        let merged = merge_states(&base, &dismissed_state);
        assert_eq!(merged.requests, vec![other.clone()]);
        assert_eq!(merged.dismissals, vec![dismissal.clone()]);

        // Carrying the request and its dismissal together is invalid.
        let both = state_with(
            Vec::new(),
            Vec::new(),
            vec![request.clone()],
            vec![dismissal.clone()],
            None,
        );
        assert_eq!(validate_state_with(&owner, &both), ValidateResult::Invalid);

        // A non-owner dismissal does not verify and its delta is skipped.
        let forged = signed_dismissal(&member_a(), &request);
        assert!(!forged.is_valid(&key));
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                dismissals: vec![forged],
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());

        // Replaying the dismissed request does not bring it back.
        let after = update(
            &owner,
            &merged,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                requests: vec![request],
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.requests, vec![other]);
        assert_eq!(after.dismissals, vec![dismissal]);
    }

    // ---- 6. config ---------------------------------------------------------

    #[test]
    fn config_seq_and_tie_rules() {
        let owner = owner();
        let key = owner.verifying_key();

        let accepting = signed_config(&owner, 1, true);
        let closing = signed_config(&owner, 2, false);
        assert!(accepting.is_valid(&key));
        assert!(closing.is_valid(&key));

        let base = state_with(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(accepting.clone()),
        );
        assert_eq!(validate_state_with(&owner, &base), ValidateResult::Valid);

        // Higher seq wins.
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                config: Some(closing.clone()),
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.config, Some(closing.clone()));

        // Lower seq is ignored.
        let after = update(
            &owner,
            &after,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                config: Some(accepting.clone()),
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.config, Some(closing.clone()));

        // Equal seq resolves by signature bytes, independently of order.
        let tie_a = signed_config(&owner, 5, true);
        let tie_b = signed_config(&owner, 5, false);
        let winner = if config_greater(&tie_a, &tie_b) {
            tie_a.clone()
        } else {
            tie_b.clone()
        };
        for (left, right) in [(&tie_a, &tie_b), (&tie_b, &tie_a)] {
            let left_state = state_with(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Some(left.clone()),
            );
            let right_state = state_with(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Some(right.clone()),
            );
            assert_eq!(
                merge_states(&left_state, &right_state).config,
                Some(winner.clone())
            );
        }

        // seq == 0 is invalid, as is a bad signature.
        let zero = signed_config(&owner, 0, true);
        assert!(!zero.is_valid(&key));
        let mut bad = closing.clone();
        bad.sig = "00".repeat(64);
        assert!(!bad.is_valid(&key));
    }

    // ---- 7. membership/message behaviour unchanged ------------------------

    #[test]
    fn non_member_cannot_author_removal_and_readmission() {
        let owner = owner();
        let a = member_a();

        let epoch_one = membership_of(&owner, 1, &[&owner, &a]);
        let old_message = signed_message(&owner, &a, 1, 1, 1_000, b"hello");
        let base = state_of(vec![epoch_one.clone()], vec![old_message.clone()]);
        assert_eq!(validate_state_with(&owner, &base), ValidateResult::Valid);

        // A non-member cannot author.
        let outsider_message = signed_message(&owner, &member_b(), 1, 1, 1_500, b"let me in");
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                messages: vec![outsider_message],
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());

        // Removal takes effect at the next epoch; old messages remain history.
        let epoch_two = membership_of(&owner, 2, &[&owner]);
        let after_removal = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                memberships: vec![epoch_two.clone()],
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after_removal.messages, vec![old_message.clone()]);
        assert_eq!(after_removal.memberships, vec![epoch_one, epoch_two]);

        let rejected = signed_message(&owner, &a, 2, 2, 2_000, b"not any more");
        let after = update(
            &owner,
            &after_removal,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                messages: vec![rejected],
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.messages, vec![old_message.clone()]);

        // Re-admission brings the author back for the new epoch.
        let epoch_three = membership_of(&owner, 3, &[&owner, &a]);
        let readmitted = signed_message(&owner, &a, 3, 3, 3_000, b"back");
        let after = update(
            &owner,
            &after,
            vec![
                UpdateData::Delta(delta_bytes(&Delta {
                    memberships: vec![epoch_three],
                    ..empty_delta()
                })),
                UpdateData::Delta(delta_bytes(&Delta {
                    messages: vec![readmitted.clone()],
                    ..empty_delta()
                })),
            ],
        )
        .unwrap();
        assert_eq!(after.messages, vec![old_message, readmitted]);
        assert_eq!(validate_state_with(&owner, &after), ValidateResult::Valid);
    }

    // ---- 8. merge laws -----------------------------------------------------

    fn merge_law_states() -> Vec<State> {
        let owner = owner();
        let a = member_a();
        let b = member_b();
        let epoch_one = membership_of(&owner, 1, &[&owner, &a, &b]);
        let epoch_two = membership_of(&owner, 2, &[&owner, &a]);
        let epoch_three = membership_of(&owner, 3, &[&owner]);
        let epoch_four = membership_of(&owner, 4, &[&owner, &b]);

        let r1 = signed_request(&owner, &a, 10, "0", b"r1");
        let r2 = signed_request(&owner, &b, 11, "", b"r2");
        let r3 = signed_request(&owner, &a, 12, "003", b"r3");
        let r4 = signed_request(&owner, &outsider(), 13, "0", b"r4");
        let r5 = signed_request(&owner, &outsider(), 14, "1", b"r5");
        let dismiss_r2 = signed_dismissal(&owner, &r2);
        let config_one = signed_config(&owner, 1, true);
        let config_two = signed_config(&owner, 2, false);

        let first = state_with(
            vec![epoch_one],
            vec![
                signed_message(&owner, &a, 1, 1, 10, b"a1"),
                signed_message(&owner, &b, 1, 1, 20, b"b1"),
            ],
            vec![r1, r2],
            Vec::new(),
            None,
        );
        let second = state_with(
            vec![epoch_two],
            vec![signed_message(&owner, &a, 2, 2, 30, b"a2")],
            vec![r3, r4],
            vec![dismiss_r2],
            Some(config_one),
        );
        let third = state_with(
            vec![epoch_three, epoch_four],
            vec![signed_message(&owner, &b, 4, 3, 40, b"b4")],
            vec![r5],
            Vec::new(),
            Some(config_two),
        );
        vec![first, second, third]
    }

    #[test]
    fn merge_is_commutative_associative_and_idempotent() {
        let states = merge_law_states();
        let expected = merge_order(&states, &ORDERS[0]).to_bytes();
        for order in ORDERS {
            assert_eq!(merge_order(&states, &order).to_bytes(), expected);
        }

        let mut pairwise = states[0].clone();
        pairwise.merge(&states[1]);
        pairwise.merge(&states[2]);
        assert_eq!(pairwise.to_bytes(), expected);

        let mut idempotent = merge_order(&states, &ORDERS[0]);
        idempotent.merge(&idempotent.clone());
        assert_eq!(idempotent.to_bytes(), expected);

        // Content checks: r2 was dismissed, config 2 wins.
        let merged = merge_order(&states, &ORDERS[0]);
        assert_eq!(merged.requests.len(), 4);
        assert!(
            !merged
                .requests
                .iter()
                .any(|request| request.id() == merged.dismissals[0].id)
        );
        assert_eq!(merged.config.map(|config| config.seq), Some(2));
        assert_eq!(merged.dismissals.len(), 1);
    }

    fn deltas_for(state: &State) -> Vec<Delta> {
        let mut deltas = Vec::new();
        for record in &state.memberships {
            deltas.push(Delta {
                memberships: vec![record.clone()],
                ..empty_delta()
            });
        }
        if !state.messages.is_empty() {
            deltas.push(Delta {
                messages: state.messages.clone(),
                ..empty_delta()
            });
        }
        if !state.requests.is_empty() {
            deltas.push(Delta {
                requests: state.requests.clone(),
                ..empty_delta()
            });
        }
        if !state.dismissals.is_empty() {
            deltas.push(Delta {
                dismissals: state.dismissals.clone(),
                ..empty_delta()
            });
        }
        if let Some(config) = &state.config {
            deltas.push(Delta {
                config: Some(config.clone()),
                ..empty_delta()
            });
        }
        deltas
    }

    #[test]
    fn merge_laws_hold_under_delta_replay_in_any_order() {
        let owner = owner();
        let states = merge_law_states();
        let expected = merge_order(&states, &ORDERS[0]);

        for order in ORDERS {
            let mut current = State::empty();
            for &index in &order {
                let data = deltas_for(&states[index])
                    .iter()
                    .map(delta_bytes)
                    .map(UpdateData::Delta)
                    .collect();
                current = update(&owner, &current, data).unwrap();
            }
            assert_eq!(current.to_bytes(), expected.to_bytes(), "order {order:?}");
            assert_eq!(validate_state_with(&owner, &current), ValidateResult::Valid);
        }
    }

    // ---- 9. bounded history ----------------------------------------------

    #[test]
    fn bounded_requests_and_dismissals_are_deterministic() {
        let owner = owner();

        // Requests: tied times, id as tiebreaker, newest eight survive.
        let requests: Vec<Request> = (0..10i64)
            .map(|index| {
                signed_request(
                    &owner,
                    &outsider(),
                    index / 2,
                    "0",
                    format!("r{index}").as_bytes(),
                )
            })
            .collect();
        let mut sorted_requests = requests.clone();
        sorted_requests.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
        let expected_requests: Vec<String> = sorted_requests[2..]
            .iter()
            .map(|request| request.id())
            .collect();

        let left = state_with(
            Vec::new(),
            Vec::new(),
            requests[..6].to_vec(),
            Vec::new(),
            None,
        );
        let right = state_with(
            Vec::new(),
            Vec::new(),
            requests[4..].to_vec(),
            Vec::new(),
            None,
        );
        for (a, b) in [(&left, &right), (&right, &left)] {
            let merged = merge_states(a, b);
            let ids: Vec<String> = merged.requests.iter().map(|request| request.id()).collect();
            assert_eq!(ids, expected_requests);
        }

        // Dismissals: the greatest 64 ids survive.
        let dismissals: Vec<Dismissal> = (0..70u64)
            .map(|index| dismissal_over(&owner, &format!("{index:032x}")))
            .collect();
        let expected_dismissals: Vec<String> = dismissals[6..]
            .iter()
            .map(|dismissal| dismissal.id.clone())
            .collect();

        let left = state_with(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            dismissals[..40].to_vec(),
            None,
        );
        let right = state_with(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            dismissals[30..].to_vec(),
            None,
        );
        for (a, b) in [(&left, &right), (&right, &left)] {
            let merged = merge_states(a, b);
            let ids: Vec<String> = merged
                .dismissals
                .iter()
                .map(|dismissal| dismissal.id.clone())
                .collect();
            assert_eq!(ids, expected_dismissals);
        }
    }

    #[test]
    fn bounded_memberships_and_messages_are_deterministic() {
        let owner = owner();
        let a = member_a();

        let epochs: Vec<Membership> = (1u64..=40)
            .map(|seq| membership_of(&owner, seq, &[&owner, &a]))
            .collect();
        let messages: Vec<Message> = (0..210u64)
            .map(|seq| signed_message(&owner, &a, 40, seq + 1, 1_000, format!("m{seq}").as_bytes()))
            .collect();
        assert!(messages.iter().all(|message| message.time == 1_000));

        let mut left_epochs = epochs[..20].to_vec();
        left_epochs.push(epochs[39].clone());
        let left = state_of(left_epochs, messages[..140].to_vec());
        let right = state_of(epochs[15..].to_vec(), messages[100..].to_vec());

        let mut expected = State::empty();
        expected.merge(&left);
        expected.merge(&right);
        let mut swapped = State::empty();
        swapped.merge(&right);
        swapped.merge(&left);
        assert_eq!(swapped.to_bytes(), expected.to_bytes());

        assert_eq!(expected.memberships.len(), MAX_MEMBERSHIPS);
        assert_eq!(expected.memberships.first().map(|r| r.seq), Some(9));
        assert_eq!(expected.memberships.last().map(|r| r.seq), Some(40));

        let mut all = sorted(messages);
        let expected_ids: Vec<String> = all
            .split_off(all.len() - MAX_MESSAGES)
            .into_iter()
            .map(|message| message.id())
            .collect();
        let actual_ids: Vec<String> = expected.messages.iter().map(|m| m.id()).collect();
        assert_eq!(actual_ids, expected_ids);
    }

    // ---- 10. summary and delta --------------------------------------------

    #[test]
    fn summary_and_delta_round_trip_and_converge() {
        let owner = owner();
        let a = member_a();
        let request = signed_request(&owner, &outsider(), 5, "003", b"please");
        let state = state_with(
            vec![membership_of(&owner, 1, &[&owner, &a])],
            vec![signed_message(&owner, &a, 1, 1, 5, b"hello")],
            vec![request],
            Vec::new(),
            Some(signed_config(&owner, 1, true)),
        );
        let behind = State::empty();

        let summary =
            CandidateContract::summarize_state(params(&owner), HostState::from(state.to_bytes()))
                .unwrap();
        let decoded = Summary::decode(summary.as_ref()).unwrap();
        assert_eq!(decoded.v, STATE_VERSION);
        assert_eq!(decoded.digest, state_digest(&state));
        assert_eq!(decoded.digest.len(), DIGEST_HEX_LEN);

        let empty_delta = CandidateContract::get_state_delta(
            params(&owner),
            HostState::from(state.to_bytes()),
            summary.clone(),
        )
        .unwrap();
        assert!(empty_delta.as_ref().is_empty());

        let behind_summary =
            CandidateContract::summarize_state(params(&owner), HostState::from(behind.to_bytes()))
                .unwrap();
        let delta = CandidateContract::get_state_delta(
            params(&owner),
            HostState::from(state.to_bytes()),
            behind_summary,
        )
        .unwrap();
        let decoded: Delta = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(decoded.v, STATE_VERSION);
        assert_eq!(decoded.full.as_ref(), Some(&state));

        let converged = update(
            &owner,
            &behind,
            vec![UpdateData::Delta(StateDelta::from(delta.as_ref().to_vec()))],
        )
        .unwrap();
        assert_eq!(converged.to_bytes(), state.to_bytes());
        assert_eq!(
            state_digest(&converged),
            Summary::decode(summary.as_ref()).unwrap().digest
        );

        let again = update(
            &owner,
            &converged,
            vec![UpdateData::Delta(delta_bytes(&full_delta(&state)))],
        )
        .unwrap();
        assert_eq!(again.to_bytes(), state.to_bytes());

        // An empty/undecodable summary is treated as "send the full state".
        let garbage = CandidateContract::get_state_delta(
            params(&owner),
            HostState::from(state.to_bytes()),
            StateSummary::from(b"not a summary".to_vec()),
        )
        .unwrap();
        let decoded: Delta = Delta::decode(garbage.as_ref()).unwrap();
        assert_eq!(decoded.full.as_ref(), Some(&state));
    }

    // ---- 11. invalid deltas and independent merging ----------------------

    #[test]
    fn invalid_delta_is_skipped_and_request_and_dismissal_merge_independently() {
        let owner = owner();
        let request = signed_request(&owner, &member_a(), 10, "0", b"hi");
        let dismissal = signed_dismissal(&owner, &request);

        // Adding a request and dismissing it may arrive in either order.
        for dismissal_first in [false, true] {
            let mut state = State::empty();
            let request_delta = Delta {
                requests: vec![request.clone()],
                ..empty_delta()
            };
            let dismissal_delta = Delta {
                dismissals: vec![dismissal.clone()],
                ..empty_delta()
            };
            let data = if dismissal_first {
                vec![
                    UpdateData::Delta(StateDelta::from(b"not json".to_vec())),
                    UpdateData::Delta(delta_bytes(&dismissal_delta)),
                    UpdateData::Delta(delta_bytes(&request_delta)),
                ]
            } else {
                vec![
                    UpdateData::Delta(delta_bytes(&request_delta)),
                    UpdateData::Delta(StateDelta::from(b"not json".to_vec())),
                    UpdateData::Delta(delta_bytes(&dismissal_delta)),
                ]
            };
            state = update(&owner, &state, data).unwrap();
            assert!(state.requests.is_empty());
            assert_eq!(state.dismissals, vec![dismissal.clone()]);

            // A request whose id is dismissed is dropped on merge.
            let merged = merge_states(
                &state_with(
                    Vec::new(),
                    Vec::new(),
                    vec![request.clone()],
                    Vec::new(),
                    None,
                ),
                &state,
            );
            assert!(merged.requests.is_empty());
        }

        // A malformed delta does not block an otherwise valid membership delta.
        let mut bad = signed_request(&owner, &member_a(), 1, "0", b"bad");
        bad.sig = "00".repeat(64);
        let good_membership = membership_of(&owner, 1, &[&owner]);
        let state = update(
            &owner,
            &State::empty(),
            vec![
                UpdateData::Delta(delta_bytes(&Delta {
                    requests: vec![bad],
                    ..empty_delta()
                })),
                UpdateData::Delta(delta_bytes(&Delta {
                    memberships: vec![good_membership.clone()],
                    ..empty_delta()
                })),
            ],
        )
        .unwrap();
        assert_eq!(state.memberships, vec![good_membership]);
    }

    // ---- 12. delta caps ----------------------------------------------------

    #[test]
    fn delta_caps_reject_oversized_batches() {
        let owner = owner();
        let a = member_a();
        let base = state_of(vec![membership_of(&owner, 1, &[&owner, &a])], Vec::new());

        let messages: Vec<Message> = (0..=MAX_MESSAGES_PER_DELTA as u64)
            .map(|seq| signed_message(&owner, &a, 1, seq + 1, 0, b"x"))
            .collect();
        assert_eq!(messages.len(), MAX_MESSAGES_PER_DELTA + 1);
        let too_many_messages = Delta {
            messages,
            ..empty_delta()
        };

        let too_many_memberships = Delta {
            memberships: vec![
                membership_of(&owner, 2, &[&owner]),
                membership_of(&owner, 3, &[&owner]),
            ],
            ..empty_delta()
        };

        let requests: Vec<Request> = (0..=MAX_REQUESTS_PER_DELTA as i64)
            .map(|time| signed_request(&owner, &a, time, "0", b"x"))
            .collect();
        assert_eq!(requests.len(), MAX_REQUESTS_PER_DELTA + 1);
        let too_many_requests = Delta {
            requests,
            ..empty_delta()
        };

        let dismissals: Vec<Dismissal> = (0..=MAX_DISMISSALS_PER_DELTA as u64)
            .map(|index| dismissal_over(&owner, &format!("{index:032x}")))
            .collect();
        assert_eq!(dismissals.len(), MAX_DISMISSALS_PER_DELTA + 1);
        let too_many_dismissals = Delta {
            dismissals,
            ..empty_delta()
        };

        for delta in [
            too_many_messages.clone(),
            too_many_memberships,
            too_many_requests,
            too_many_dismissals,
        ] {
            let after =
                update(&owner, &base, vec![UpdateData::Delta(delta_bytes(&delta))]).unwrap();
            assert_eq!(after.to_bytes(), base.to_bytes());
        }

        // Exactly sixteen messages applies.
        let mut exactly = too_many_messages;
        exactly.messages.pop();
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&exactly))],
        )
        .unwrap();
        assert_eq!(after.messages.len(), MAX_MESSAGES_PER_DELTA);

        // `full` is mutually exclusive with every incremental field.
        let full_plus_config = Delta {
            full: Some(base.clone()),
            config: Some(signed_config(&owner, 1, true)),
            ..empty_delta()
        };
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&full_plus_config))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());

        // Two configs in one delta are unrepresentable: the duplicate JSON key
        // is rejected before any signature loop.
        let config_json = serde_json::to_string(&signed_config(&owner, 1, true)).unwrap();
        let raw = format!(r#"{{"v":1,"config":{config_json},"config":{config_json}}}"#);
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(StateDelta::from(raw.into_bytes()))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());
    }

    // ---- 13. canonical JSON ------------------------------------------------

    #[test]
    fn canonical_json_round_trips_and_rejects_unknown_fields() {
        let owner = owner();
        let request = signed_request(&owner, &outsider(), 9, "003", b"note");
        let state = state_with(
            vec![membership_with_secrets(
                &owner,
                1,
                &[&owner, &member_a()],
                &[b"\x01", b"\x02\x03"],
            )],
            vec![signed_message(&owner, &member_a(), 1, 1, 9, b"body")],
            vec![request],
            Vec::new(),
            Some(signed_config(&owner, 1, true)),
        );
        let bytes = state.to_bytes();
        assert_eq!(State::decode(&bytes).unwrap().to_bytes(), bytes);

        for pointer in [
            "",
            "/memberships/0",
            "/memberships/0/secrets/0",
            "/messages/0",
            "/requests/0",
            "/config",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), serde_json::Value::from(1));
            assert!(
                State::decode(&serde_json::to_vec(&value).unwrap()).is_err(),
                "unknown field at {pointer:?} must be rejected"
            );
        }

        // Dismissals are also strict.
        let dismissal =
            signed_dismissal(&owner, &signed_request(&owner, &outsider(), 1, "0", b"x"));
        let mut value = serde_json::to_value(&dismissal).unwrap();
        value["unknown"] = 1.into();
        assert!(serde_json::from_value::<Dismissal>(value).is_err());

        // Delta too.
        let mut value = serde_json::to_value(empty_delta()).unwrap();
        value["unknown"] = 1.into();
        assert!(Delta::decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn config_is_required_and_serializes_as_null() {
        assert_eq!(
            String::from_utf8(State::empty().to_bytes()).unwrap(),
            r#"{"v":1,"memberships":[],"messages":[],"requests":[],"dismissals":[],"config":null}"#
        );

        let initial: serde_json::Value =
            serde_json::from_str(include_str!("../initial_state.json")).unwrap();
        assert!(initial.get("config").is_some());
        assert!(initial["config"].is_null());

        let mut value = initial.clone();
        value.as_object_mut().unwrap().remove("config");
        assert!(State::decode(&serde_json::to_vec(&value).unwrap()).is_err());

        // A delta may omit config: it means "no config change".
        let delta = Delta::decode(br#"{"v":1}"#).unwrap();
        assert!(delta.config.is_none());
    }

    // ---- 14. cross-owner and cross-tag replay -----------------------------

    #[test]
    fn cross_owner_and_cross_tag_replay_is_rejected() {
        let owner = owner();
        let other = member_b();
        let key = owner.verifying_key();
        let other_key = other.verifying_key();
        let a = member_a();

        let membership = membership_of(&owner, 1, &[&owner, &a]);
        let message = signed_message(&owner, &a, 1, 1, 1, b"hi");
        let request = signed_request(&owner, &a, 2, "0", b"hi");
        let dismissal = signed_dismissal(&owner, &request);
        let config = signed_config(&owner, 1, true);

        assert!(membership.is_valid(&key));
        assert!(message.is_valid(&key));
        assert!(request.is_valid(&key));
        assert!(dismissal.is_valid(&key));
        assert!(config.is_valid(&key));

        assert!(!membership.is_valid(&other_key));
        assert!(!message.is_valid(&other_key));
        assert!(!request.is_valid(&other_key));
        assert!(!dismissal.is_valid(&other_key));
        assert!(!config.is_valid(&other_key));

        // Records signed under the members-room tag do not verify here.
        let mut tagged_membership = membership.clone();
        tagged_membership.sig = hex::encode(
            owner
                .sign(&membership_signing_bytes_with_tag(
                    b"ZMR1",
                    &key,
                    &tagged_membership,
                ))
                .to_bytes(),
        );
        assert!(!tagged_membership.is_valid(&key));

        let mut tagged_message = message.clone();
        tagged_message.sig = hex::encode(
            a.sign(&message_signing_bytes_with_tag(
                b"ZMR1",
                &key,
                &tagged_message,
            ))
            .to_bytes(),
        );
        assert!(!tagged_message.is_valid(&key));

        let mut tagged_request = request.clone();
        tagged_request.sig = hex::encode(
            a.sign(&request_signing_bytes_with_tag(
                b"ZMR1",
                &key,
                &tagged_request,
            ))
            .to_bytes(),
        );
        assert!(!tagged_request.is_valid(&key));

        let mut tagged_dismissal = dismissal.clone();
        tagged_dismissal.sig = hex::encode(
            owner
                .sign(&dismissal_signing_bytes_with_tag(
                    b"ZMR1",
                    &key,
                    &tagged_dismissal.id,
                ))
                .to_bytes(),
        );
        assert!(!tagged_dismissal.is_valid(&key));

        let mut tagged_config = config.clone();
        tagged_config.sig = hex::encode(
            owner
                .sign(&config_signing_bytes_with_tag(
                    b"ZMR1",
                    &key,
                    &tagged_config,
                ))
                .to_bytes(),
        );
        assert!(!tagged_config.is_valid(&key));

        // update_state skips the replayed request instead of applying it.
        let state = state_of(vec![membership_of(&owner, 2, &[&owner, &a])], Vec::new());
        let after = update(
            &owner,
            &state,
            vec![UpdateData::Delta(delta_bytes(&Delta {
                requests: vec![tagged_request],
                ..empty_delta()
            }))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), state.to_bytes());
    }

    // ---- 15. golden vectors ------------------------------------------------

    #[test]
    fn golden_vectors_match_the_contract_encoding() {
        let fixture: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
        assert_eq!(fixture["tag"], "ZCR1");

        let owner_bytes: [u8; 32] = hex::decode(fixture["owner_vk_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let owner_key = VerifyingKey::from_bytes(&owner_bytes).unwrap();
        assert_eq!(hex::encode(owner_key.to_bytes()), fixture["owner_vk_hex"]);

        let state: State = serde_json::from_value(fixture["state"].clone()).unwrap();
        assert!(state.validate(&owner_key).is_ok());
        assert_eq!(state.memberships.len(), 1);
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.requests.len(), 1);
        assert!(state.dismissals.is_empty());
        assert!(state.config.is_some());

        let record = &state.memberships[0];
        assert_eq!(
            hex::encode(membership_signing_bytes(&owner_key, record)),
            fixture["membership"]["signing_bytes_hex"]
        );
        assert_eq!(record.sig, fixture["membership"]["sig_hex"]);

        let message = &state.messages[0];
        assert_eq!(
            hex::encode(message_signing_bytes(&owner_key, message)),
            fixture["message"]["signing_bytes_hex"]
        );
        assert_eq!(message.sig, fixture["message"]["sig_hex"]);
        assert_eq!(message.id(), fixture["message"]["id"]);

        let request = &state.requests[0];
        assert_eq!(
            hex::encode(request_signing_bytes(&owner_key, request)),
            fixture["request"]["signing_bytes_hex"]
        );
        assert_eq!(request.sig, fixture["request"]["sig_hex"]);
        assert_eq!(request.id(), fixture["request"]["id"]);

        let dismissal = Dismissal {
            id: fixture["dismissal"]["id"].as_str().unwrap().to_string(),
            sig: fixture["dismissal"]["sig_hex"]
                .as_str()
                .unwrap()
                .to_string(),
        };
        assert!(dismissal.is_valid(&owner_key));
        assert_eq!(
            hex::encode(dismissal_signing_bytes(&owner_key, &dismissal.id)),
            fixture["dismissal"]["signing_bytes_hex"]
        );

        let config = state.config.as_ref().unwrap();
        assert_eq!(
            hex::encode(config_signing_bytes(&owner_key, config)),
            fixture["config"]["signing_bytes_hex"]
        );
        assert_eq!(config.sig, fixture["config"]["sig_hex"]);

        assert_eq!(
            hex::encode(state.to_bytes()),
            fixture["state_bytes_hex"],
            "canonical state bytes are pinned"
        );
        assert_eq!(state_digest(&state), fixture["digest"]);
        assert_eq!(
            fixture["state"]["v"],
            serde_json::Value::from(STATE_VERSION)
        );
    }

    // ---- proptest merge laws ----------------------------------------------

    proptest! {
        #[test]
        fn proptest_merge_is_a_join_semilattice(
            seqs_a in prop::collection::vec(1u64..6, 1..4),
            seqs_b in prop::collection::vec(1u64..6, 1..4),
            seqs_c in prop::collection::vec(1u64..6, 1..4),
            times in prop::collection::vec(0i64..50, 1..8),
            request_times in prop::collection::vec(0i64..50, 1..8),
            config_seqs in prop::collection::vec(1u64..4, 3..=3),
        ) {
            let owner = owner();
            let member = member_a();
            let requester = member_b();

            let requests: Vec<Request> = request_times
                .iter()
                .enumerate()
                .map(|(index, &time)| {
                    signed_request(
                        &owner,
                        &requester,
                        time,
                        "003",
                        format!("p{index}").as_bytes(),
                    )
                })
                .collect();
            let dismissals: Vec<Dismissal> = requests
                .iter()
                .enumerate()
                .filter(|(index, _)| index % 4 == 0)
                .map(|(_, request)| signed_dismissal(&owner, request))
                .collect();

            let build = |seqs: &[u64], part: usize, config_seq: u64| {
                let mut epochs = seqs.to_vec();
                epochs.sort_unstable();
                epochs.dedup();
                let memberships: Vec<Membership> = epochs
                    .iter()
                    .map(|&seq| membership_of(&owner, seq, &[&owner, &member]))
                    .collect();
                let epoch = *epochs.last().unwrap();
                let messages: Vec<Message> = times
                    .iter()
                    .enumerate()
                    .map(|(index, &time)| {
                        signed_message(
                            &owner,
                            &member,
                            epoch,
                            index as u64 + 1,
                            time,
                            format!("{index}").as_bytes(),
                        )
                    })
                    .collect();
                let own: Vec<Request> = requests
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| index % 3 == part)
                    .map(|(_, request)| request.clone())
                    .collect();
                let own_ids: HashSet<String> =
                    own.iter().map(|request| request.id()).collect();
                let own_dismissals: Vec<Dismissal> = dismissals
                    .iter()
                    .filter(|dismissal| !own_ids.contains(&dismissal.id))
                    .cloned()
                    .collect();
                state_with(
                    memberships,
                    messages,
                    own,
                    own_dismissals,
                    Some(signed_config(&owner, config_seq, config_seq % 2 == 0)),
                )
            };

            let sa = build(&seqs_a, 0, config_seqs[0]);
            let sb = build(&seqs_b, 1, config_seqs[1]);
            let sc = build(&seqs_c, 2, config_seqs[2]);

            // commutative
            prop_assert_eq!(
                merge_states(&sa, &sb).to_bytes(),
                merge_states(&sb, &sa).to_bytes()
            );
            // associative
            let left = merge_states(&merge_states(&sa, &sb), &sc);
            let right = merge_states(&sa, &merge_states(&sb, &sc));
            prop_assert_eq!(left.to_bytes(), right.to_bytes());
            // idempotent
            prop_assert_eq!(merge_states(&sa, &sa).to_bytes(), sa.to_bytes());
        }
    }
}
