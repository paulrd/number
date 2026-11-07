//! `number-room` — the members room of `DESIGN-rooms.md` (P3a).
//!
//! One contract instance per room, derived from a 36-byte parameter blob
//! `b"ZMR1" || owner_vk`. The contract accepts `ZMR1` only: the candidate room
//! (`ZCR1`) is a separate WASM so adding its request queue later cannot re-key
//! existing members rooms.
//!
//! State v1 is a grow-only set of owner-signed membership revisions plus
//! author-signed messages. Memberships are a history: a message at epoch `N`
//! stays valid history after the member is removed at epoch `N+1`. Message
//! bodies and epoch-secret blobs are opaque bytes; encryption is client-side
//! (P3c).
//!
//! Merge is a join semilattice:
//!
//! - memberships: union by `seq`, equal `seq` keeps the lexicographically
//!   greater signature, keep the newest [`MAX_MEMBERSHIPS`];
//! - messages: union by `id` (BLAKE3 of the raw signature), drop messages whose
//!   epoch is outside the merged membership window or whose author was not a
//!   member at that epoch, keep the newest [`MAX_MESSAGES`] by `(time, id)`.
//!
//! The contract never reads the host clock and never uses randomness — the
//! caller supplies `time`.

use ed25519_dalek::{Signature, VerifyingKey};
use freenet_stdlib::prelude::State as HostState;
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Room-kind tag in the parameters and in every canonical signing payload.
pub const ROOM_TAG: &[u8; 4] = b"ZMR1";

/// Exact length of the parameters blob: tag + raw Ed25519 owner key.
pub const PARAMETERS_LEN: usize = 36;

/// State schema version written to (and required in) every state object.
pub const STATE_VERSION: u8 = 1;

/// Owners plus eight slots.
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
/// Largest message count in one incremental delta.
pub const MAX_MESSAGES_PER_DELTA: usize = 16;
/// Largest membership count in one incremental delta.
pub const MAX_MEMBERSHIPS_PER_DELTA: usize = 1;

/// Hex length of a raw 32-byte key.
pub const KEY_HEX_LEN: usize = 64;
/// Hex length of a raw 64-byte signature.
pub const SIGNATURE_HEX_LEN: usize = 128;
/// Hex length of a derived 16-byte message id / state digest.
pub const DIGEST_HEX_LEN: usize = 32;

/// Domain prefix of the canonical membership signing bytes.
pub const SIGNING_DOMAIN_MEMBERSHIP: &[u8] = b"number:v1:room:membership";
/// Domain prefix of the canonical message signing bytes.
pub const SIGNING_DOMAIN_MESSAGE: &[u8] = b"number:v1:room:message";

/// Extract the owner key from the parameters.
///
/// Requires exactly [`PARAMETERS_LEN`] bytes, starting with [`ROOM_TAG`] and
/// ending with a valid Ed25519 verifying key. `ZCR1` is rejected here; it is a
/// different room kind with its own WASM.
pub fn owner_key(parameters: &Parameters<'_>) -> Result<VerifyingKey, ContractError> {
    let bytes = parameters.as_ref();
    if bytes.len() != PARAMETERS_LEN {
        return Err(ContractError::Other(
            "room parameters must be exactly 36 bytes".into(),
        ));
    }
    if &bytes[..4] != ROOM_TAG {
        return Err(ContractError::Other(
            "room parameters must start with ZMR1".into(),
        ));
    }
    let key: [u8; 32] = bytes[4..]
        .try_into()
        .map_err(|_| ContractError::Other("room owner key must be 32 bytes".into()))?;
    VerifyingKey::from_bytes(&key)
        .map_err(|_| ContractError::Other("room parameters are not an Ed25519 point".into()))
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
    if value.is_empty() || value.len() % 2 != 0 {
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

/// One author-signed message. `body` is opaque (plaintext in P3a/P3b,
/// ciphertext from P3c).
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

/// Full room state v1.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub v: u8,
    pub memberships: Vec<Membership>,
    pub messages: Vec<Message>,
}

impl State {
    /// The shared initial state, valid for every owner.
    pub fn empty() -> Self {
        Self {
            v: STATE_VERSION,
            memberships: Vec::new(),
            messages: Vec::new(),
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

    /// Validate the version, bounds, ordering, uniqueness, epoch membership and
    /// every signature under `owner`.
    pub fn validate(&self, owner: &VerifyingKey) -> Result<(), ContractError> {
        if self.v != STATE_VERSION
            || self.memberships.len() > MAX_MEMBERSHIPS
            || self.messages.len() > MAX_MESSAGES
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
    let messages = a
        .messages
        .iter()
        .chain(b.messages.iter())
        .cloned()
        .collect();
    State {
        v: STATE_VERSION,
        memberships: memberships.clone(),
        messages: merge_messages(&memberships, messages),
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

/// Canonical membership signing bytes (`DESIGN-rooms.md` §3):
///
/// ```text
/// b"number:v1:room:membership"
/// || tag: 4 bytes                       // b"ZMR1"
/// || owner_vk: 32 bytes
/// || seq: u64 LE
/// || member_count: u16 LE
/// || each member ascending: 32 bytes
/// || secret_count: u16 LE
/// || each secret ascending by recipient:
///      recipient: 32 bytes || blob_len: u32 LE || blob
/// ```
///
/// The record order is used as given; validation requires ascending order.
pub fn membership_signing_bytes(owner: &VerifyingKey, record: &Membership) -> Vec<u8> {
    membership_signing_bytes_with_tag(ROOM_TAG, owner, record)
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

/// Canonical message signing bytes (`DESIGN-rooms.md` §3):
///
/// ```text
/// b"number:v1:room:message"
/// || tag: 4 bytes                       // b"ZMR1"
/// || owner_vk: 32 bytes
/// || author: 32 bytes
/// || epoch: u64 LE
/// || seq: u64 LE
/// || time: i64 LE
/// || body_len: u32 LE
/// || body
/// ```
pub fn message_signing_bytes(owner: &VerifyingKey, message: &Message) -> Vec<u8> {
    message_signing_bytes_with_tag(ROOM_TAG, owner, message)
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
/// delta carrying at most one membership and sixteen messages.
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
    /// checked before any membership signature loop.
    fn staged(&self, owner: &VerifyingKey) -> Result<Staged, ContractError> {
        if self.v != STATE_VERSION {
            return Err(ContractError::InvalidDelta);
        }
        if let Some(full) = &self.full {
            if !self.memberships.is_empty() || !self.messages.is_empty() {
                return Err(ContractError::InvalidDelta);
            }
            full.validate(owner)?;
            return Ok(Staged::Full(Box::new(full.clone())));
        }
        if self.memberships.len() > MAX_MEMBERSHIPS_PER_DELTA
            || self.messages.len() > MAX_MESSAGES_PER_DELTA
        {
            return Err(ContractError::InvalidDelta);
        }
        for record in &self.memberships {
            if !record.is_valid(owner) {
                return Err(ContractError::InvalidDelta);
            }
        }
        Ok(Staged::Incremental {
            memberships: self.memberships.clone(),
            messages: self.messages.clone(),
        })
    }
}

/// A structurally validated incoming update.
enum Staged {
    Full(Box<State>),
    Incremental {
        memberships: Vec<Membership>,
        messages: Vec<Message>,
    },
}

/// The room contract.
pub struct RoomContract;

#[contract]
impl ContractInterface for RoomContract {
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
        // validate/collect messages against the merged epoch history.
        let mut memberships = current.memberships.clone();
        let mut candidates = current.messages.clone();
        for item in staged {
            match item {
                Staged::Full(incoming) => {
                    memberships = merge_memberships(&memberships, &incoming.memberships);
                    candidates.extend(incoming.messages);
                }
                Staged::Incremental {
                    memberships: incoming_memberships,
                    messages,
                } => {
                    memberships = merge_memberships(&memberships, &incoming_memberships);
                    for message in messages {
                        if message.is_valid(&owner) {
                            candidates.push(message);
                        }
                    }
                }
            }
        }
        let messages = merge_messages(&memberships, candidates);
        let result = State {
            v: STATE_VERSION,
            memberships,
            messages,
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
        };
        Ok(StateDelta::from(delta.to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use proptest::prelude::*;

    const GOLDEN: &str = include_str!("../../fixtures/rooms/golden_v1.json");

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

    fn owner_hex(signing: &SigningKey) -> String {
        hex::encode(signing.verifying_key().to_bytes())
    }

    fn params(signing: &SigningKey) -> Parameters<'static> {
        let mut bytes = Vec::with_capacity(PARAMETERS_LEN);
        bytes.extend_from_slice(ROOM_TAG);
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
        // Pair keys with blobs, then sort by key so secrets follow the member
        // order.
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

    fn sorted(mut messages: Vec<Message>) -> Vec<Message> {
        messages.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id().cmp(&b.id())));
        messages
    }

    fn state_of(memberships: Vec<Membership>, messages: Vec<Message>) -> State {
        State {
            v: STATE_VERSION,
            memberships,
            messages: sorted(messages),
        }
    }

    fn validate_state_with(owner: &SigningKey, state: &State) -> ValidateResult {
        RoomContract::validate_state(
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
        let updated =
            RoomContract::update_state(params(owner), HostState::from(state.to_bytes()), data)?;
        Ok(State::decode(updated.unwrap_valid().as_ref()).unwrap())
    }

    fn delta_bytes(delta: &Delta) -> StateDelta<'static> {
        StateDelta::from(delta.to_bytes())
    }

    fn full_delta(state: &State) -> Delta {
        Delta {
            v: STATE_VERSION,
            full: Some(state.clone()),
            memberships: Vec::new(),
            messages: Vec::new(),
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

        // Same empty state, wrong kind tag or length: invalid.
        let mut zcr1 = params(&owner()).as_ref().to_vec();
        zcr1[..4].copy_from_slice(b"ZCR1");
        assert_eq!(
            RoomContract::validate_state(
                Parameters::from(zcr1),
                HostState::from(initial.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
        let mut short = params(&owner()).as_ref().to_vec();
        short.pop();
        assert_eq!(
            RoomContract::validate_state(
                Parameters::from(short),
                HostState::from(initial.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn messages_without_memberships_are_invalid() {
        let owner = owner();
        let state = State {
            v: STATE_VERSION,
            memberships: Vec::new(),
            messages: vec![signed_message(&owner, &member_a(), 1, 1, 0, b"orphan")],
        };
        assert_eq!(validate_state_with(&owner, &state), ValidateResult::Invalid);
        assert!(state.validate(&owner.verifying_key()).is_err());
    }

    #[test]
    fn parameters_must_be_zmr1_and_exactly_36_bytes() {
        let owner = owner();
        let good = params(&owner);
        assert_eq!(owner_key(&good).unwrap(), owner.verifying_key());

        let mut zcr1 = good.as_ref().to_vec();
        zcr1[..4].copy_from_slice(b"ZCR1");
        assert!(owner_key(&Parameters::from(zcr1)).is_err());

        for length in [0usize, 4, 35, 37, 68] {
            let mut bytes = good.as_ref().to_vec();
            bytes.resize(length, 0);
            assert!(
                owner_key(&Parameters::from(bytes)).is_err(),
                "length {length} must fail"
            );
        }

        // A 36-byte blob whose key half is not a valid Ed25519 point.
        let mut bad_point = good.as_ref().to_vec();
        bad_point[4..].fill(0x02);
        assert!(owner_key(&Parameters::from(bad_point)).is_err());
    }

    // ---- 2. every-field tamper tests --------------------------------------

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

        // Same fields, different room owner: the owner is in the signing bytes.
        let other = member_b();
        assert!(!good.is_valid(&other.verifying_key()));
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

        // Sign the descending order, then present the ascending order: the
        // member sequence is part of the payload, so the signature must fail.
        let mut wrong_order = Membership {
            seq: 1,
            members: descending,
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(&owner, &mut wrong_order);
        wrong_order.members = ascending;
        assert!(!wrong_order.is_valid(&key));

        // Secret recipient and blob bytes are signed.
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

        let mut tampered = good.clone();
        tampered.secrets[0].recipient = owner_hex(&member_b());
        assert!(!tampered.is_valid(&key));
    }

    #[test]
    fn message_signature_binds_every_field() {
        let owner = owner();
        let key = owner.verifying_key();
        let good = signed_message(&owner, &member_a(), 1, 1, 1_762_500_000_000, b"hello");
        assert!(good.is_valid(&key));

        let mut tampered = good.clone();
        tampered.author = owner_hex(&member_b());
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.epoch = 2;
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.seq = 2;
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.time += 1;
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.body = hex::encode(b"hellp");
        assert!(!tampered.is_valid(&key));

        let mut tampered = good.clone();
        tampered.sig = "00".repeat(64);
        assert!(!tampered.is_valid(&key));

        // Same author and body in a different owner's room.
        let other = member_b();
        assert!(!good.is_valid(&other.verifying_key()));
    }

    // ---- 3. bounds ---------------------------------------------------------

    #[test]
    fn membership_member_and_secret_bounds() {
        let owner = owner();
        let key = owner.verifying_key();

        assert!(!membership_of(&owner, 0, &[&owner]).is_valid(&key));

        // Zero members.
        let mut record = Membership {
            seq: 1,
            members: Vec::new(),
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(&owner, &mut record);
        assert!(!record.is_valid(&key));

        // Ten members.
        let seeds: Vec<SigningKey> = (0u8..9).map(|seed| test_key(100 + seed)).collect();
        let mut keys: Vec<String> = seeds.iter().map(owner_hex).collect();
        keys.push(owner_hex(&owner));
        keys.sort();
        let mut ten = Membership {
            seq: 1,
            members: keys,
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(&owner, &mut ten);
        assert_eq!(ten.members.len(), 10);
        assert!(!ten.is_valid(&key));

        // Duplicate member.
        let mut duplicate = Membership {
            seq: 1,
            members: vec![owner_hex(&owner), owner_hex(&owner)],
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(&owner, &mut duplicate);
        assert!(!duplicate.is_valid(&key));

        // Unsorted members (and duplicate-free but descending).
        let mut descending = vec![owner_hex(&owner), owner_hex(&member_a())];
        descending.sort();
        descending.reverse();
        let mut unsorted = Membership {
            seq: 1,
            members: descending,
            secrets: Vec::new(),
            sig: String::new(),
        };
        signed_membership(&owner, &mut unsorted);
        assert!(!unsorted.is_valid(&key));

        // Uppercase hex is not lowercase hex, even if the bytes decode.
        let mut uppercase = membership_of(&owner, 1, &[&owner, &member_a()]);
        uppercase.members[0] = uppercase.members[0].to_uppercase();
        signed_membership(&owner, &mut uppercase);
        assert!(!uppercase.is_valid(&key));

        // Owner absent.
        assert!(!membership_of(&owner, 1, &[&member_a()]).is_valid(&key));

        // Partial secrets.
        let mut partial = membership_of(&owner, 1, &[&owner, &member_a()]);
        partial.secrets = vec![Secret {
            recipient: owner_hex(&owner),
            blob: "01".into(),
        }];
        signed_membership(&owner, &mut partial);
        assert!(!partial.is_valid(&key));

        // Oversized secret blob (257 bytes).
        let mut oversized = Membership {
            seq: 1,
            members: vec![owner_hex(&owner)],
            secrets: vec![Secret {
                recipient: owner_hex(&owner),
                blob: hex::encode([0u8; MAX_SECRET_BLOB_BYTES + 1]),
            }],
            sig: String::new(),
        };
        signed_membership(&owner, &mut oversized);
        assert!(!oversized.is_valid(&key));

        // Empty blob is invalid; one byte is valid.
        let mut empty_blob = oversized.clone();
        empty_blob.secrets[0].blob = String::new();
        signed_membership(&owner, &mut empty_blob);
        assert!(!empty_blob.is_valid(&key));
    }

    #[test]
    fn message_body_and_hex_bounds() {
        let owner = owner();
        let key = owner.verifying_key();

        let empty = signed_message(&owner, &member_a(), 1, 1, 0, b"");
        assert!(!empty.is_valid(&key));

        let oversized_body = vec![0x41u8; MAX_BODY_BYTES + 1];
        let oversized = signed_message(&owner, &member_a(), 1, 1, 0, &oversized_body);
        assert!(!oversized.is_valid(&key));

        let largest_body = vec![0x41u8; MAX_BODY_BYTES];
        let largest = signed_message(&owner, &member_a(), 1, 1, 0, &largest_body);
        assert!(largest.is_valid(&key));

        let mut message = largest.clone();
        message.author = "AB".repeat(32);
        assert!(!message.is_valid(&key));

        let mut message = largest.clone();
        message.body = "0".into();
        assert!(!message.is_valid(&key));

        let mut message = largest.clone();
        message.body = "zz".into();
        assert!(!message.is_valid(&key));

        let mut message = largest.clone();
        message.sig = "AB".repeat(64);
        assert!(!message.is_valid(&key));

        let mut message = largest;
        message.epoch = 0;
        assert!(!message.is_valid(&key));
    }

    // ---- 4. author membership ---------------------------------------------

    #[test]
    fn outsider_cannot_author_and_state_is_unchanged() {
        let owner = owner();
        let base = state_of(vec![membership_of(&owner, 1, &[&owner])], Vec::new());
        assert_eq!(validate_state_with(&owner, &base), ValidateResult::Valid);

        let outsider = signed_message(&owner, &member_a(), 1, 1, 0, b"let me in");
        let delta = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: Vec::new(),
            messages: vec![outsider.clone()],
        };

        let after = update(&owner, &base, vec![UpdateData::Delta(delta_bytes(&delta))]).unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());

        // A structurally valid but unauthorised state is invalid.
        let invalid = state_of(vec![membership_of(&owner, 1, &[&owner])], vec![outsider]);
        assert_eq!(
            validate_state_with(&owner, &invalid),
            ValidateResult::Invalid
        );

        // A message naming an epoch that is not retained is also invalid.
        let base_with_member = state_of(
            vec![membership_of(&owner, 1, &[&owner, &member_a()])],
            Vec::new(),
        );
        let unknown_epoch = signed_message(&owner, &member_a(), 2, 1, 0, b"future");
        let invalid = state_of(
            base_with_member.memberships.clone(),
            vec![unknown_epoch.clone()],
        );
        assert_eq!(
            validate_state_with(&owner, &invalid),
            ValidateResult::Invalid
        );

        // update_state drops the unknown-epoch message and keeps the delta's
        // rest (here: nothing else) without failing the call.
        let delta = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: Vec::new(),
            messages: vec![unknown_epoch],
        };
        let after = update(
            &owner,
            &base_with_member,
            vec![UpdateData::Delta(delta_bytes(&delta))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base_with_member.to_bytes());
    }

    // ---- 5. removal and history -------------------------------------------

    #[test]
    fn removal_takes_effect_at_the_next_epoch_and_old_messages_survive() {
        let owner = owner();
        let removed = member_a();
        let epoch_two = membership_of(&owner, 2, &[&owner, &removed]);
        let old_message = signed_message(&owner, &removed, 2, 1, 1_000, b"still here");
        let base = state_of(vec![epoch_two.clone()], vec![old_message.clone()]);
        assert_eq!(validate_state_with(&owner, &base), ValidateResult::Valid);

        let epoch_three = membership_of(&owner, 3, &[&owner]);
        let removed_delta = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: vec![epoch_three.clone()],
            messages: Vec::new(),
        };
        let after_removal = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&removed_delta))],
        )
        .unwrap();
        assert_eq!(
            after_removal.memberships,
            vec![epoch_two.clone(), epoch_three]
        );
        assert_eq!(after_removal.messages, vec![old_message.clone()]);

        // The removed member cannot post at the new epoch; the old-epoch
        // message stays, subject only to eviction.
        let rejected = signed_message(&owner, &removed, 3, 2, 2_000, b"not any more");
        let delta = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: Vec::new(),
            messages: vec![rejected],
        };
        let after = update(
            &owner,
            &after_removal,
            vec![UpdateData::Delta(delta_bytes(&delta))],
        )
        .unwrap();
        assert_eq!(after.messages, vec![old_message]);
        assert_eq!(validate_state_with(&owner, &after), ValidateResult::Valid);
    }

    // ---- 6. merge laws -----------------------------------------------------

    fn merge_law_states() -> Vec<State> {
        let owner = owner();
        let a = member_a();
        let b = member_b();
        let epoch_one = membership_of(&owner, 1, &[&owner, &a, &b]);
        let epoch_two = membership_of(&owner, 2, &[&owner, &a]);
        let epoch_three = membership_of(&owner, 3, &[&owner]);
        let epoch_four = membership_of(&owner, 4, &[&owner, &b]);

        let first = state_of(
            vec![epoch_one.clone()],
            vec![
                signed_message(&owner, &a, 1, 1, 10, b"a1"),
                signed_message(&owner, &b, 1, 1, 20, b"b1"),
            ],
        );
        let second = state_of(
            vec![epoch_two.clone()],
            vec![signed_message(&owner, &a, 2, 2, 30, b"a2")],
        );
        let third = state_of(
            vec![epoch_three.clone(), epoch_four.clone()],
            vec![
                signed_message(&owner, &b, 1, 1, 20, b"b1"),
                signed_message(&owner, &b, 4, 3, 40, b"b4"),
            ],
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

        let mut idempotent = expected_state(&states);
        idempotent.merge(&idempotent.clone());
        assert_eq!(idempotent.to_bytes(), expected);
    }

    fn expected_state(states: &[State]) -> State {
        let mut result = State::empty();
        for state in states {
            result.merge(state);
        }
        result
    }

    #[test]
    fn merge_laws_hold_under_delta_replay_in_any_order() {
        let owner = owner();
        let states = merge_law_states();
        let expected = expected_state(&states);

        // Replay the same records as standalone delta batches in every order.
        for order in ORDERS {
            let mut current = State::empty();
            for &index in &order {
                let delta = Delta {
                    v: STATE_VERSION,
                    full: None,
                    memberships: states[index].memberships.clone(),
                    messages: states[index].messages.clone(),
                };
                let mut data = Vec::new();
                for record in delta.memberships {
                    data.push(UpdateData::Delta(delta_bytes(&Delta {
                        v: STATE_VERSION,
                        full: None,
                        memberships: vec![record],
                        messages: Vec::new(),
                    })));
                }
                data.push(UpdateData::Delta(delta_bytes(&Delta {
                    v: STATE_VERSION,
                    full: None,
                    memberships: Vec::new(),
                    messages: delta.messages,
                })));
                current = update(&owner, &current, data).unwrap();
            }
            assert_eq!(current.to_bytes(), expected.to_bytes(), "order {order:?}");
        }
    }

    // ---- 7. bounded history ------------------------------------------------

    #[test]
    fn top_memberships_and_messages_are_deterministic_under_shuffled_arrival() {
        let owner = owner();
        let a = member_a();
        let epochs: Vec<Membership> = (1u64..=40)
            .map(|seq| membership_of(&owner, seq, &[&owner, &a]))
            .collect();

        let messages: Vec<Message> = (0..210u64)
            .map(|seq| signed_message(&owner, &a, 40, seq + 1, 1_000, format!("m{seq}").as_bytes()))
            .collect();
        // Tie on time: the id is the tiebreaker, so arrival order cannot matter.
        assert!(messages.iter().all(|message| message.time == 1_000));

        // Both sides are individually valid states; each carries epoch 40.
        let mut left_epochs = epochs[..20].to_vec();
        left_epochs.push(epochs[39].clone());
        let left = state_of(left_epochs, messages[..140].to_vec());
        let right = state_of(epochs[15..].to_vec(), messages[100..].to_vec());

        let expected = {
            let mut result = State::empty();
            result.merge(&left);
            result.merge(&right);
            result
        };
        let mut swapped = State::empty();
        swapped.merge(&right);
        swapped.merge(&left);
        assert_eq!(swapped.to_bytes(), expected.to_bytes());

        assert_eq!(expected.memberships.len(), MAX_MEMBERSHIPS);
        assert_eq!(
            expected.memberships.first().map(|record| record.seq),
            Some(9)
        );
        assert_eq!(
            expected.memberships.last().map(|record| record.seq),
            Some(40)
        );

        assert_eq!(expected.messages.len(), MAX_MESSAGES);
        let expected_ids: Vec<String> = {
            let mut all: Vec<Message> = messages.to_vec();
            all = sorted(all);
            all.into_iter()
                .rev()
                .take(MAX_MESSAGES)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .map(|message| message.id())
                .collect()
        };
        let actual_ids: Vec<String> = expected.messages.iter().map(|m| m.id()).collect();
        assert_eq!(actual_ids, expected_ids);
    }

    #[test]
    fn membership_window_eviction_drops_old_epoch_messages() {
        let owner = owner();
        let a = member_a();
        let old = state_of(
            vec![membership_of(&owner, 1, &[&owner, &a])],
            vec![signed_message(&owner, &a, 1, 1, 1, b"old")],
        );
        let mut newer = State::empty();
        for seq in 2u64..=40 {
            newer
                .memberships
                .push(membership_of(&owner, seq, &[&owner, &a]));
        }
        let merged = {
            let mut result = old.clone();
            result.merge(&newer);
            result
        };
        assert_eq!(merged.memberships.len(), 32);
        assert!(merged.messages.is_empty(), "epoch 1 fell out of the window");

        // A message in the surviving window is kept.
        let mut kept = newer.clone();
        kept.messages = vec![signed_message(&owner, &a, 40, 1, 2, b"kept")];
        let merged = {
            let mut result = old;
            result.merge(&kept);
            result
        };
        assert_eq!(merged.messages.len(), 1);
        assert_eq!(merged.messages[0].epoch, 40);
    }

    // ---- 8. summary and delta ---------------------------------------------

    #[test]
    fn summary_and_delta_round_trip_and_converge() {
        let owner = owner();
        let a = member_a();
        let state = state_of(
            vec![membership_of(&owner, 1, &[&owner, &a])],
            vec![signed_message(&owner, &a, 1, 1, 5, b"hello")],
        );
        let behind = State::empty();

        let summary =
            RoomContract::summarize_state(params(&owner), HostState::from(state.to_bytes()))
                .unwrap();
        let decoded = Summary::decode(summary.as_ref()).unwrap();
        assert_eq!(decoded.v, STATE_VERSION);
        assert_eq!(decoded.digest, state_digest(&state));
        assert_eq!(decoded.digest.len(), DIGEST_HEX_LEN);

        // Equal digest -> empty delta.
        let empty_delta = RoomContract::get_state_delta(
            params(&owner),
            HostState::from(state.to_bytes()),
            summary.clone(),
        )
        .unwrap();
        assert!(empty_delta.as_ref().is_empty());

        // Behind -> full state catch-up.
        let behind_summary =
            RoomContract::summarize_state(params(&owner), HostState::from(behind.to_bytes()))
                .unwrap();
        let delta = RoomContract::get_state_delta(
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

        // Applying the same full state again is a no-op (idempotent).
        let again = update(
            &owner,
            &converged,
            vec![UpdateData::Delta(delta_bytes(&full_delta(&state)))],
        )
        .unwrap();
        assert_eq!(again.to_bytes(), state.to_bytes());
    }

    // ---- 9. invalid deltas and batching ------------------------------------

    #[test]
    fn invalid_delta_is_skipped_and_membership_merges_before_messages() {
        let owner = owner();
        let a = member_a();
        let base = State::empty();

        let record = membership_of(&owner, 1, &[&owner, &a]);
        let message = signed_message(&owner, &a, 1, 1, 10, b"first");
        let valid = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: vec![record.clone()],
            messages: vec![message.clone()],
        };

        let after = update(
            &owner,
            &base,
            vec![
                UpdateData::Delta(StateDelta::from(b"not json".to_vec())),
                UpdateData::Delta(delta_bytes(&valid)),
            ],
        )
        .unwrap();
        assert_eq!(after.memberships, vec![record]);
        assert_eq!(after.messages, vec![message]);

        // An otherwise well-formed delta with a bad membership signature is
        // skipped without blocking a valid one.
        let mut bad_record = membership_of(&owner, 2, &[&owner]);
        bad_record.sig = "00".repeat(64);
        let bad = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: vec![bad_record],
            messages: Vec::new(),
        };
        let good_record = membership_of(&owner, 3, &[&owner, &a]);
        let good = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: vec![good_record.clone()],
            messages: Vec::new(),
        };
        let after = update(
            &owner,
            &after,
            vec![
                UpdateData::Delta(delta_bytes(&bad)),
                UpdateData::Delta(delta_bytes(&good)),
            ],
        )
        .unwrap();
        assert_eq!(after.memberships.len(), 2);
        assert!(after.membership(2).is_none());
        assert_eq!(after.membership(3), Some(&good_record));
    }

    // ---- 10. delta caps ----------------------------------------------------

    #[test]
    fn delta_caps_reject_oversized_batches() {
        let owner = owner();
        let a = member_a();
        let base = state_of(vec![membership_of(&owner, 1, &[&owner, &a])], Vec::new());

        let messages: Vec<Message> = (0..=MAX_MESSAGES_PER_DELTA as u64)
            .map(|seq| signed_message(&owner, &a, 1, seq + 1, 0, b"x"))
            .collect();
        assert_eq!(messages.len(), 17);
        let too_many_messages = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: Vec::new(),
            messages,
        };
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&too_many_messages))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());

        let too_many_memberships = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: vec![
                membership_of(&owner, 2, &[&owner]),
                membership_of(&owner, 3, &[&owner]),
            ],
            messages: Vec::new(),
        };
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&too_many_memberships))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), base.to_bytes());

        // Exactly sixteen messages applies.
        let mut exactly = too_many_messages.clone();
        exactly.messages.pop();
        let after = update(
            &owner,
            &base,
            vec![UpdateData::Delta(delta_bytes(&exactly))],
        )
        .unwrap();
        assert_eq!(after.messages.len(), MAX_MESSAGES_PER_DELTA);
    }

    // ---- 11. canonical JSON ------------------------------------------------

    #[test]
    fn canonical_json_round_trips_and_rejects_unknown_fields() {
        let owner = owner();
        let state = state_of(
            vec![membership_with_secrets(
                &owner,
                1,
                &[&owner, &member_a()],
                &[b"\x01", b"\x02\x03"],
            )],
            vec![signed_message(&owner, &member_a(), 1, 1, 9, b"body")],
        );
        let bytes = state.to_bytes();
        assert_eq!(State::decode(&bytes).unwrap().to_bytes(), bytes);

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["unknown"] = 1.into();
        assert!(State::decode(&serde_json::to_vec(&value).unwrap()).is_err());

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["memberships"][0]["unknown"] = 1.into();
        assert!(State::decode(&serde_json::to_vec(&value).unwrap()).is_err());

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["memberships"][0]["secrets"][0]["unknown"] = 1.into();
        assert!(State::decode(&serde_json::to_vec(&value).unwrap()).is_err());

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["messages"][0]["unknown"] = 1.into();
        assert!(State::decode(&serde_json::to_vec(&value).unwrap()).is_err());

        // Removing a field with serde_json still decodes (the struct knows its
        // own shape); canonical bytes are produced from the typed state.
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["messages"] = serde_json::Value::Array(Vec::new());
        let without_messages = State::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(without_messages.messages.is_empty());
        assert_eq!(without_messages.memberships.len(), 1);
    }

    // ---- 12. cross-room replay --------------------------------------------

    #[test]
    fn cross_owner_and_cross_tag_replay_is_rejected() {
        let owner = owner();
        let other_owner = member_b();
        let a = member_a();

        let good = membership_of(&owner, 1, &[&owner, &a]);
        let message = signed_message(&owner, &a, 1, 1, 1, b"hi");
        assert!(good.is_valid(&owner.verifying_key()));
        assert!(!good.is_valid(&other_owner.verifying_key()));
        assert!(message.is_valid(&owner.verifying_key()));
        assert!(!message.is_valid(&other_owner.verifying_key()));

        // Sign the same records against the candidate-room tag.
        let mut tagged = Membership {
            seq: 1,
            members: good.members.clone(),
            secrets: Vec::new(),
            sig: String::new(),
        };
        tagged.sig = hex::encode(
            owner
                .sign(&membership_signing_bytes_with_tag(
                    b"ZCR1",
                    &owner.verifying_key(),
                    &tagged,
                ))
                .to_bytes(),
        );
        assert!(!tagged.is_valid(&owner.verifying_key()));

        let mut tagged_message = message.clone();
        tagged_message.sig = hex::encode(
            a.sign(&message_signing_bytes_with_tag(
                b"ZCR1",
                &owner.verifying_key(),
                &tagged_message,
            ))
            .to_bytes(),
        );
        assert!(!tagged_message.is_valid(&owner.verifying_key()));

        // And update_state skips the replayed delta instead of applying it.
        let mut state = state_of(vec![membership_of(&owner, 2, &[&owner, &a])], Vec::new());
        state.v = STATE_VERSION;
        let replay = Delta {
            v: STATE_VERSION,
            full: None,
            memberships: vec![tagged],
            messages: vec![tagged_message],
        };
        let after = update(
            &owner,
            &state,
            vec![UpdateData::Delta(delta_bytes(&replay))],
        )
        .unwrap();
        assert_eq!(after.to_bytes(), state.to_bytes());
    }

    // ---- 13. golden vectors ------------------------------------------------

    #[test]
    fn golden_vectors_match_the_contract_encoding() {
        let fixture: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
        assert_eq!(fixture["tag"], "ZMR1");

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
        assert_eq!(
            message.id(),
            hex::encode(digest16(&signature_raw(&message.sig)))
        );

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
            a in prop::collection::vec(1u64..6, 1..4),
            b in prop::collection::vec(1u64..6, 1..4),
            c in prop::collection::vec(1u64..6, 1..4),
            times in prop::collection::vec(0i64..50, 1..8),
        ) {
            // Build three valid single-owner states from generated seq/times.
            let owner = owner();
            let member = member_a();
            let build = |seqs: &[u64], times: &[i64]| {
                let mut epochs = seqs.to_vec();
                epochs.sort_unstable();
                epochs.dedup();
                let memberships: Vec<Membership> = epochs
                    .iter()
                    .map(|&seq| membership_of(&owner, seq, &[&owner, &member]))
                    .collect();
                let messages: Vec<Message> = times
                    .iter()
                    .enumerate()
                    .map(|(index, &time)| {
                        let epoch = *epochs.last().unwrap();
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
                state_of(memberships, messages)
            };
            let sa = build(&a, &times);
            let sb = build(&b, &times);
            let sc = build(&c, &times);

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
