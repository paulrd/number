//! `number-contract` — one board per owner, with exactly eight number slots.
//!
//! The contract is parameterised by the owner's raw 32-byte Ed25519 verifying
//! key. Every non-empty (`seq > 0`) slot carries an Ed25519 signature over the
//! canonical bytes defined in `DESIGN.md` §2. State is a fixed-size array of
//! eight slots, so encoding is deterministic and the merge is a slot-wise
//! maximum; there are no maps, caps or removals in state.
//!
//! The contract never reads the host clock and never uses randomness.

use ed25519_dalek::{Signature, VerifyingKey};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};

/// Number of slots in a board. This is fixed by the design.
pub const SLOT_COUNT: usize = 8;

/// Maximum length of `Entry::label` in UTF-8 bytes.
pub const MAX_LABEL_BYTES: usize = 64;
/// Maximum length of `Entry::unit` in UTF-8 bytes.
pub const MAX_UNIT_BYTES: usize = 16;
/// Maximum length of `Entry::note` in UTF-8 bytes.
pub const MAX_NOTE_BYTES: usize = 512;

/// State schema version written to (and required in) every wire object.
pub const STATE_VERSION: u8 = 1;

/// Domain prefix of the canonical signing bytes. Changing this is a breaking
/// state change; see `DESIGN.md` §2.
pub const SIGNING_DOMAIN: &[u8] = b"number:v1:slot";

/// A single slot value. Every field is covered by the slot signature.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub value: i64,
    /// Optional; `null` and absent decode identically and encode as `null`.
    #[serde(default)]
    pub label: Option<String>,
    /// Optional; `null` and absent decode identically and encode as `null`.
    #[serde(default)]
    pub unit: Option<String>,
    /// Optional; `null` and absent decode identically and encode as `null`.
    #[serde(default)]
    pub note: Option<String>,
}

impl Entry {
    /// Whether the metadata fields are within the byte bounds from §2.
    pub fn within_bounds(&self) -> bool {
        self.label
            .as_deref()
            .is_none_or(|value| value.len() <= MAX_LABEL_BYTES)
            && self
                .unit
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_UNIT_BYTES)
            && self
                .note
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_NOTE_BYTES)
    }
}

/// One of the eight board slots.
///
/// `seq == 0` is the empty slot (`entry` and `sig` are `None`). `seq > 0` with
/// `entry == None` is a legal tombstone: the slot was cleared at that sequence.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub seq: u64,
    pub entry: Option<Entry>,
    pub sig: Option<String>,
}

impl Slot {
    /// The initial, empty slot.
    pub fn empty() -> Self {
        Self {
            seq: 0,
            entry: None,
            sig: None,
        }
    }

    /// Whether this slot is valid at `index` under `key`.
    ///
    /// Covers the seq-0 invariant, metadata bounds, signature hex form and the
    /// Ed25519 signature over the canonical bytes.
    pub fn is_valid(&self, index: u8, key: &VerifyingKey) -> bool {
        if usize::from(index) >= SLOT_COUNT {
            return false;
        }
        if self.seq == 0 {
            return self.entry.is_none() && self.sig.is_none();
        }
        if self
            .entry
            .as_ref()
            .is_some_and(|entry| !entry.within_bounds())
        {
            return false;
        }
        let Some(signature) = self.sig.as_deref().and_then(parse_signature) else {
            return false;
        };
        let bytes = signing_bytes(index, self.seq, self.entry.as_ref());
        key.verify_strict(&bytes, &signature).is_ok()
    }
}

/// Full contract state (§2).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StateV1 {
    pub v: u8,
    pub slots: [Slot; SLOT_COUNT],
}

impl StateV1 {
    /// An all-empty board.
    pub fn empty() -> Self {
        Self {
            v: STATE_VERSION,
            slots: std::array::from_fn(|_| Slot::empty()),
        }
    }

    /// Decode JSON state bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, ContractError> {
        serde_json::from_slice(bytes).map_err(|_| ContractError::InvalidState)
    }

    /// Encode state deterministically as JSON.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("StateV1 serialization cannot fail")
    }

    /// Validate version, slot count (enforced by the array type), the seq-0
    /// invariant, metadata bounds and every signature under `key`.
    pub fn validate(&self, key: &VerifyingKey) -> Result<(), ContractError> {
        if self.v != STATE_VERSION {
            return Err(ContractError::InvalidState);
        }
        for (index, slot) in self.slots.iter().enumerate() {
            if !slot.is_valid(index as u8, key) {
                return Err(ContractError::InvalidState);
            }
        }
        Ok(())
    }

    /// Merge `other` slot-wise. This is a maximum over the total order from §5,
    /// so it is associative, commutative, idempotent and absorbing.
    pub fn merge(&mut self, other: &Self) {
        for (index, other_slot) in other.slots.iter().enumerate() {
            self.slots[index] = merge_slot(&self.slots[index], other_slot);
        }
    }
}

/// Slot-wise merge: higher `seq` wins; on equal `seq` the lexicographically
/// greater signature bytes win.
fn merge_slot(a: &Slot, b: &Slot) -> Slot {
    if a.seq > b.seq {
        return a.clone();
    }
    if b.seq > a.seq {
        return b.clone();
    }
    if signature_bytes(a) >= signature_bytes(b) {
        a.clone()
    } else {
        b.clone()
    }
}

/// The signature field as bytes. Empty slots (and any malformed sig, which the
/// validators reject before merging) compare as all-zero bytes.
fn signature_bytes(slot: &Slot) -> [u8; 64] {
    slot.sig
        .as_deref()
        .and_then(|sig| {
            let bytes = hex::decode(sig).ok()?;
            bytes.try_into().ok()
        })
        .unwrap_or([0; 64])
}

/// Canonical signing bytes, hand-built exactly as specified in `DESIGN.md` §2.
///
/// ```text
/// b"number:v1:slot"
/// || slot_index: u8
/// || seq: u64 little-endian
/// || entry_tag: u8            // 0 = None, 1 = Some
/// // only when entry_tag == 1:
/// || value: i64 little-endian
/// || label_len: u32 LE || label bytes
/// || unit_len:  u32 LE || unit bytes
/// || note_len:  u32 LE || note bytes
/// ```
///
/// `None` optional strings encode as length 0.
pub fn signing_bytes(slot_index: u8, seq: u64, entry: Option<&Entry>) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(SIGNING_DOMAIN);
    out.push(slot_index);
    out.extend_from_slice(&seq.to_le_bytes());
    match entry {
        None => out.push(0),
        Some(entry) => {
            out.push(1);
            out.extend_from_slice(&entry.value.to_le_bytes());
            push_optional_string(&mut out, entry.label.as_deref());
            push_optional_string(&mut out, entry.unit.as_deref());
            push_optional_string(&mut out, entry.note.as_deref());
        }
    }
    out
}

fn push_optional_string(out: &mut Vec<u8>, value: Option<&str>) {
    let bytes = value.unwrap_or_default().as_bytes();
    let len = u32::try_from(bytes.len()).expect("metadata bounds keep lengths below u32::MAX");
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(bytes);
}

fn parse_signature(sig: &str) -> Option<Signature> {
    // The schema requires exactly 128 lowercase hex characters.
    if sig.len() != 128
        || !sig
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let bytes = hex::decode(sig).ok()?;
    let array: [u8; 64] = bytes.try_into().ok()?;
    Some(Signature::from_bytes(&array))
}

/// Summary of one slot (§3): `[seq, first 16 bytes of BLAKE3(signing bytes)]`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SlotSummary(pub u64, pub String);

/// State summary (§3). Exactly eight pairs; the digest is all-zero for an
/// empty slot.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub v: u8,
    pub slots: [SlotSummary; SLOT_COUNT],
}

impl Summary {
    /// Build the summary for `state`.
    pub fn of(state: &StateV1) -> Self {
        let slots = std::array::from_fn(|index| {
            let slot = &state.slots[index];
            if slot.seq == 0 {
                SlotSummary(0, hex::encode([0u8; 16]))
            } else {
                let digest = digest16(&signing_bytes(index as u8, slot.seq, slot.entry.as_ref()));
                SlotSummary(slot.seq, hex::encode(digest))
            }
        });
        Self {
            v: STATE_VERSION,
            slots,
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
        if summary.v != STATE_VERSION {
            return Err(ContractError::InvalidDelta);
        }
        for slot in &summary.slots {
            summary_digest(&slot.1)?;
            if slot.0 == 0 {
                // An empty slot's digest is defined as 16 zero bytes.
                if summary_digest(&slot.1)? != [0u8; 16] {
                    return Err(ContractError::InvalidDelta);
                }
            }
        }
        Ok(summary)
    }
}

fn digest16(bytes: &[u8]) -> [u8; 16] {
    let hash = blake3::hash(bytes);
    let mut digest = [0u8; 16];
    digest.copy_from_slice(&hash.as_bytes()[..16]);
    digest
}

fn summary_digest(value: &str) -> Result<[u8; 16], ContractError> {
    let bytes = hex::decode(value).map_err(|_| ContractError::InvalidDelta)?;
    bytes.try_into().map_err(|_| ContractError::InvalidDelta)
}

/// One changed slot in a delta (§4).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DeltaSlot {
    pub i: u8,
    pub seq: u64,
    pub entry: Option<Entry>,
    pub sig: Option<String>,
}

impl DeltaSlot {
    fn from_slot(index: u8, slot: &Slot) -> Self {
        Self {
            i: index,
            seq: slot.seq,
            entry: slot.entry.clone(),
            sig: slot.sig.clone(),
        }
    }

    fn to_slot(&self) -> Slot {
        Slot {
            seq: self.seq,
            entry: self.entry.clone(),
            sig: self.sig.clone(),
        }
    }
}

/// State delta (§4).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Delta {
    pub v: u8,
    pub slots: Vec<DeltaSlot>,
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

    /// Validate every slot in the delta under `key`, returning the slots to
    /// merge. Validation is all-or-nothing before any slot is applied.
    fn validated_slots(&self, key: &VerifyingKey) -> Result<Vec<(u8, Slot)>, ContractError> {
        if self.v != STATE_VERSION {
            return Err(ContractError::InvalidDelta);
        }
        let mut slots = Vec::with_capacity(self.slots.len());
        for delta_slot in &self.slots {
            if usize::from(delta_slot.i) >= SLOT_COUNT {
                return Err(ContractError::InvalidDelta);
            }
            let slot = delta_slot.to_slot();
            if !slot.is_valid(delta_slot.i, key) {
                return Err(ContractError::InvalidDelta);
            }
            slots.push((delta_slot.i, slot));
        }
        Ok(slots)
    }
}

fn owner_key(parameters: &Parameters<'_>) -> Result<VerifyingKey, ContractError> {
    let bytes: [u8; 32] = parameters
        .as_ref()
        .try_into()
        .map_err(|_| ContractError::Other("parameters must be exactly 32 bytes".into()))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| ContractError::Other("parameters are not a valid Ed25519 point".into()))
}

/// Staged, already-validated incoming update.
enum Incoming {
    Full(Box<StateV1>),
    Delta(Vec<(u8, Slot)>),
}

/// The contract implementation.
pub struct NumberContract;

#[contract]
impl ContractInterface for NumberContract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let Ok(key) = owner_key(&parameters) else {
            return Ok(ValidateResult::Invalid);
        };
        let Ok(state) = StateV1::decode(state.as_ref()) else {
            return Ok(ValidateResult::Invalid);
        };
        match state.validate(&key) {
            Ok(()) => Ok(ValidateResult::Valid),
            Err(_) => Ok(ValidateResult::Invalid),
        }
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        if data.is_empty() {
            return Ok(UpdateModification::valid(state));
        }
        let key = owner_key(&parameters)?;
        let mut current = StateV1::decode(state.as_ref())?;
        current.validate(&key)?;

        // Stage and validate everything before mutating. A single invalid slot
        // rejects the whole update (single writer, so atomicity is correct).
        let mut staged = Vec::with_capacity(data.len());
        for item in &data {
            match item {
                UpdateData::State(incoming) => {
                    let incoming = StateV1::decode(incoming.as_ref())?;
                    incoming.validate(&key)?;
                    staged.push(Incoming::Full(Box::new(incoming)));
                }
                UpdateData::Delta(delta) => {
                    let delta = Delta::decode(delta.as_ref())?;
                    staged.push(Incoming::Delta(delta.validated_slots(&key)?));
                }
                UpdateData::StateAndDelta {
                    state: incoming,
                    delta,
                } => {
                    let incoming = StateV1::decode(incoming.as_ref())?;
                    incoming.validate(&key)?;
                    let delta = Delta::decode(delta.as_ref())?;
                    let delta_slots = delta.validated_slots(&key)?;
                    staged.push(Incoming::Full(Box::new(incoming)));
                    staged.push(Incoming::Delta(delta_slots));
                }
                // Related contracts are not part of this design.
                _ => {}
            }
        }

        for incoming in staged {
            match incoming {
                Incoming::Full(incoming) => current.merge(&incoming),
                Incoming::Delta(slots) => {
                    for (index, slot) in slots {
                        let merged = merge_slot(&current.slots[usize::from(index)], &slot);
                        current.slots[usize::from(index)] = merged;
                    }
                }
            }
        }

        Ok(UpdateModification::valid(State::from(current.to_bytes())))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let state = StateV1::decode(state.as_ref())?;
        Ok(StateSummary::from(Summary::of(&state).to_bytes()))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = StateV1::decode(state.as_ref())?;
        // An empty summary is what a brand-new subscriber presents: it holds
        // nothing, so the full board is the delta. Treat an undecodable summary
        // the same way (send everything) rather than failing — a failed delta
        // aborts the subscription/notification, which is worse than re-sending
        // a board this small.
        let summary = if summary.as_ref().is_empty() {
            None
        } else {
            Summary::decode(summary.as_ref()).ok()
        };

        let mut slots = Vec::new();
        for (index, slot) in state.slots.iter().enumerate() {
            let include = match &summary {
                None => slot.seq > 0,
                Some(summary) => {
                    let remote = &summary.slots[index];
                    let remote_digest = summary_digest(&remote.1)?;
                    let local_digest = if slot.seq == 0 {
                        [0u8; 16]
                    } else {
                        digest16(&signing_bytes(index as u8, slot.seq, slot.entry.as_ref()))
                    };
                    slot.seq > remote.0 || (slot.seq == remote.0 && local_digest != remote_digest)
                }
            };
            if include {
                slots.push(DeltaSlot::from_slot(index as u8, slot));
            }
        }

        if slots.is_empty() {
            // The unambiguous "converged" answer (§4).
            return Ok(StateDelta::from(vec![]));
        }
        let delta = Delta {
            v: STATE_VERSION,
            slots,
        };
        Ok(StateDelta::from(delta.to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use proptest::prelude::*;

    const TEST_SEED: [u8; 32] = [7u8; 32];

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_SEED)
    }

    fn signed_slot(key: &SigningKey, index: u8, seq: u64, entry: Option<Entry>) -> Slot {
        let signature = key.sign(&signing_bytes(index, seq, entry.as_ref()));
        Slot {
            seq,
            entry,
            sig: Some(hex::encode(signature.to_bytes())),
        }
    }

    fn params(key: &SigningKey) -> Parameters<'static> {
        Parameters::from(key.verifying_key().to_bytes().to_vec())
    }

    fn state_of(slots: Vec<Slot>) -> StateV1 {
        let slots: [Slot; SLOT_COUNT] = slots
            .try_into()
            .expect("test helper always supplies eight slots");
        StateV1 {
            v: STATE_VERSION,
            slots,
        }
    }

    fn merged(a: &StateV1, b: &StateV1) -> StateV1 {
        let mut result = a.clone();
        result.merge(b);
        result
    }

    fn sample_entry() -> Entry {
        Entry {
            value: -42,
            label: Some("weight".into()),
            unit: Some("kg".into()),
            note: None,
        }
    }

    fn populated_state(key: &SigningKey) -> StateV1 {
        let mut state = StateV1::empty();
        state.slots[2] = signed_slot(key, 2, 4, Some(sample_entry()));
        state.slots[5] = signed_slot(key, 5, 1, None); // tombstone
        state.slots[7] = signed_slot(
            key,
            7,
            9,
            Some(Entry {
                value: i64::MIN,
                label: None,
                unit: Some("m".into()),
                note: Some("hello".into()),
            }),
        );
        state
    }

    // ---- canonical signing bytes -----------------------------------------

    #[test]
    fn golden_signing_bytes_are_pinned() {
        let entry = sample_entry();
        let bytes = signing_bytes(3, 7, Some(&entry));
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76313a736c6f7403070000000000000001d6ffffffffffffff06000000776569676874020000006b6700000000"
        );

        // The empty/tombstone form is a different fixed vector.
        assert_eq!(
            hex::encode(signing_bytes(5, 1, None)),
            "6e756d6265723a76313a736c6f7405010000000000000000"
        );
    }

    #[test]
    fn delegate_golden_signature_verifies_under_contract_rules() {
        // Cross-component pin: this signature is produced by `number-delegate`
        // (seed [7u8; 32], slot 3, seq 7, the `sample_entry` payload). It must
        // verify here or the two canonical encoders have drifted apart.
        let pubkey =
            hex::decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
                .expect("golden pubkey is hex");
        let verifying_key =
            VerifyingKey::from_bytes(&pubkey.try_into().expect("golden pubkey is 32 bytes"))
                .expect("golden pubkey is a valid point");
        let slot = Slot {
            seq: 7,
            entry: Some(sample_entry()),
            sig: Some(
                "6734e3576e846111f6f2c7cc9e01a67adf2c56ba8d6b7b4ee4e66de41df9ecef8dcecd0ac4226161df2465d432528483539f13af5b7bc5e60a2b9df3ea48eb0d"
                    .into(),
            ),
        };
        assert!(slot.is_valid(3, &verifying_key));
    }

    #[test]
    fn optional_strings_encode_as_empty_length() {
        let with_none = Entry {
            value: 1,
            label: None,
            unit: None,
            note: None,
        };
        let with_empty = Entry {
            value: 1,
            label: Some(String::new()),
            unit: Some(String::new()),
            note: Some(String::new()),
        };
        assert_eq!(
            signing_bytes(0, 1, Some(&with_none)),
            signing_bytes(0, 1, Some(&with_empty))
        );
    }

    // ---- signature tampering ---------------------------------------------

    fn assert_tampered_slot_rejected(slot: &Slot, index: u8) {
        let key = test_key();
        assert!(
            !slot.is_valid(index, &key.verifying_key()),
            "tampered slot must fail verification"
        );
    }

    #[test]
    fn tampering_with_slot_index_fails() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        assert!(slot.is_valid(3, &key.verifying_key()));
        assert_tampered_slot_rejected(&slot, 4);
    }

    #[test]
    fn tampering_with_seq_fails() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut tampered = slot.clone();
        tampered.seq = 8;
        assert_tampered_slot_rejected(&tampered, 3);
    }

    #[test]
    fn tampering_with_value_fails() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut tampered = slot;
        tampered.entry.as_mut().unwrap().value = -41;
        assert_tampered_slot_rejected(&tampered, 3);
    }

    #[test]
    fn tampering_with_label_fails() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut tampered = slot;
        tampered.entry.as_mut().unwrap().label = Some("weights".into());
        assert_tampered_slot_rejected(&tampered, 3);
    }

    #[test]
    fn tampering_with_unit_fails() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut tampered = slot;
        tampered.entry.as_mut().unwrap().unit = Some("g".into());
        assert_tampered_slot_rejected(&tampered, 3);
    }

    #[test]
    fn tampering_with_note_fails() {
        let key = test_key();
        let mut entry = sample_entry();
        entry.note = Some("before".into());
        let slot = signed_slot(&key, 3, 7, Some(entry));

        let mut changed = slot.clone();
        changed.entry.as_mut().unwrap().note = Some("after".into());
        assert_tampered_slot_rejected(&changed, 3);

        // Adding a note to a signature that covered `None` must also fail.
        let signed_without_note = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut added = signed_without_note;
        added.entry.as_mut().unwrap().note = Some("sneaky".into());
        assert_tampered_slot_rejected(&added, 3);
    }

    #[test]
    fn tampering_with_entry_presence_fails() {
        let key = test_key();
        let tombstone = signed_slot(&key, 3, 7, None);
        let mut resurrected = tombstone;
        resurrected.entry = Some(sample_entry());
        assert_tampered_slot_rejected(&resurrected, 3);

        let value = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut cleared = value;
        cleared.entry = None;
        assert_tampered_slot_rejected(&cleared, 3);
    }

    #[test]
    fn signature_must_be_lowercase_hex() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut uppercase = slot;
        uppercase.sig = uppercase.sig.map(|sig| sig.to_uppercase());
        assert_tampered_slot_rejected(&uppercase, 3);
    }

    // ---- seq-0 invariants and bounds -------------------------------------

    #[test]
    fn seq_zero_requires_null_entry_and_signature() {
        let key = test_key();
        let verifying = key.verifying_key();

        assert!(Slot::empty().is_valid(0, &verifying));

        let unsigned_entry = Slot {
            seq: 0,
            entry: Some(sample_entry()),
            sig: None,
        };
        assert!(!unsigned_entry.is_valid(0, &verifying));

        let stray_signature = Slot {
            seq: 0,
            entry: None,
            sig: Some(hex::encode([1u8; 64])),
        };
        assert!(!stray_signature.is_valid(0, &verifying));
    }

    #[test]
    fn metadata_bounds_are_inclusive() {
        let key = test_key();
        let verifying = key.verifying_key();

        let at_limit = Entry {
            value: 0,
            label: Some("l".repeat(MAX_LABEL_BYTES)),
            unit: Some("u".repeat(MAX_UNIT_BYTES)),
            note: Some("n".repeat(MAX_NOTE_BYTES)),
        };
        assert!(signed_slot(&key, 0, 1, Some(at_limit)).is_valid(0, &verifying));

        for over in [
            Entry {
                value: 0,
                label: Some("l".repeat(MAX_LABEL_BYTES + 1)),
                unit: None,
                note: None,
            },
            Entry {
                value: 0,
                label: None,
                unit: Some("u".repeat(MAX_UNIT_BYTES + 1)),
                note: None,
            },
            Entry {
                value: 0,
                label: None,
                unit: None,
                note: Some("n".repeat(MAX_NOTE_BYTES + 1)),
            },
        ] {
            assert!(
                !signed_slot(&key, 0, 1, Some(over)).is_valid(0, &verifying),
                "over-bound metadata must be rejected"
            );
        }
    }

    #[test]
    fn metadata_bounds_are_measured_in_utf8_bytes() {
        let key = test_key();
        let verifying = key.verifying_key();
        // 32 * 2 = 64 bytes: allowed even though it is only 32 characters.
        let fits = Entry {
            value: 0,
            label: Some("é".repeat(MAX_LABEL_BYTES / 2)),
            unit: None,
            note: None,
        };
        assert!(signed_slot(&key, 0, 1, Some(fits)).is_valid(0, &verifying));

        let too_long = Entry {
            value: 0,
            label: Some("é".repeat(MAX_LABEL_BYTES / 2 + 1)),
            unit: None,
            note: None,
        };
        assert!(!signed_slot(&key, 0, 1, Some(too_long)).is_valid(0, &verifying));
    }

    #[test]
    fn state_with_wrong_version_is_invalid() {
        let key = test_key();
        let mut state = populated_state(&key);
        assert!(state.validate(&key.verifying_key()).is_ok());
        state.v = 2;
        assert!(state.validate(&key.verifying_key()).is_err());
    }

    // ---- validate_state / update_state -----------------------------------

    #[test]
    fn validate_state_accepts_valid_state_and_rejects_wrong_key() {
        let key = test_key();
        let state = populated_state(&key);
        assert_eq!(
            NumberContract::validate_state(
                params(&key),
                State::from(state.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Valid
        );

        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert_eq!(
            NumberContract::validate_state(
                params(&other),
                State::from(state.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn validate_state_rejects_wrong_parameter_length() {
        let key = test_key();
        let state = populated_state(&key);
        let short = Parameters::from(vec![0u8; 31]);
        assert_eq!(
            NumberContract::validate_state(
                short,
                State::from(state.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn validate_state_rejects_wrong_slot_count() {
        let key = test_key();
        let json = r#"{"v":1,"slots":[{"seq":0,"entry":null,"sig":null}]}"#;
        assert_eq!(
            NumberContract::validate_state(
                params(&key),
                State::from(json.as_bytes().to_vec()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn update_state_merges_full_state_slot_wise() {
        let key = test_key();
        let empty = StateV1::empty();
        let incoming = populated_state(&key);
        let updated = NumberContract::update_state(
            params(&key),
            State::from(empty.to_bytes()),
            vec![UpdateData::State(State::from(incoming.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(updated.as_ref(), incoming.to_bytes().as_slice());
    }

    #[test]
    fn update_state_rejects_invalid_update_atomically() {
        let key = test_key();
        let valid = populated_state(&key);
        let mut invalid = StateV1::empty();
        // Slot 0 is valid, slot 1 is tampered; the whole update must fail and
        // must not half-apply slot 0.
        invalid.slots[0] = signed_slot(&key, 0, 1, Some(sample_entry()));
        let mut bad = signed_slot(&key, 1, 1, Some(sample_entry()));
        bad.entry.as_mut().unwrap().value = 999;
        invalid.slots[1] = bad;

        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV1::empty().to_bytes()),
            vec![UpdateData::State(State::from(invalid.to_bytes()))],
        );
        assert!(err.is_err());

        // Sanity: the original state is untouched and still validates.
        assert!(valid.validate(&key.verifying_key()).is_ok());
    }

    #[test]
    fn update_state_rejects_invalid_delta_atomically() {
        let key = test_key();
        let first = signed_slot(&key, 0, 1, Some(sample_entry()));
        let mut second = signed_slot(&key, 1, 1, Some(sample_entry()));
        second.entry.as_mut().unwrap().value = 1234;
        let delta = Delta {
            v: STATE_VERSION,
            slots: vec![
                DeltaSlot::from_slot(0, &first),
                DeltaSlot::from_slot(1, &second),
            ],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV1::empty().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        );
        assert!(err.is_err());
    }

    #[test]
    fn stale_slots_lose_the_merge_without_error() {
        let key = test_key();
        let current = populated_state(&key);
        let mut stale = current.clone();
        stale.slots[2] = signed_slot(
            &key,
            2,
            3,
            Some(Entry {
                value: 100,
                label: None,
                unit: None,
                note: None,
            }),
        );
        let updated = NumberContract::update_state(
            params(&key),
            State::from(current.to_bytes()),
            vec![UpdateData::State(State::from(stale.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(updated.as_ref(), current.to_bytes().as_slice());
    }

    // ---- summary and delta ------------------------------------------------

    fn summarize(state: &StateV1) -> StateSummary<'static> {
        NumberContract::summarize_state(
            Parameters::from(vec![0u8; 32]),
            State::from(state.to_bytes()),
        )
        .unwrap()
    }

    fn delta_from(state: &StateV1, summary: &StateSummary<'_>) -> StateDelta<'static> {
        NumberContract::get_state_delta(
            Parameters::from(vec![0u8; 32]),
            State::from(state.to_bytes()),
            StateSummary::from(summary.as_ref().to_vec()),
        )
        .unwrap()
    }

    #[test]
    fn initial_state_json_is_the_empty_board() {
        let initial: StateV1 = serde_json::from_str(include_str!("../initial_state.json")).unwrap();
        assert_eq!(initial, StateV1::empty());
    }

    #[test]
    fn wire_shapes_match_design() {
        let key = test_key();
        let state = populated_state(&key);

        let summary: serde_json::Value =
            serde_json::from_slice(&Summary::of(&state).to_bytes()).unwrap();
        assert_eq!(summary["v"], STATE_VERSION);
        let pairs = summary["slots"].as_array().unwrap();
        assert_eq!(pairs.len(), SLOT_COUNT);
        assert_eq!(
            pairs[0],
            serde_json::json!([0, "00000000000000000000000000000000"])
        );
        assert_eq!(pairs[2][0], 4);
        let digest = pairs[2][1].as_str().unwrap();
        assert_eq!(digest.len(), 32);
        assert!(digest.bytes().all(|b| b.is_ascii_hexdigit()));

        let mut delta_state = StateV1::empty();
        delta_state.slots[2] = signed_slot(&key, 2, 4, Some(sample_entry()));
        let delta = Delta {
            v: STATE_VERSION,
            slots: vec![DeltaSlot::from_slot(2, &delta_state.slots[2])],
        };
        let decoded: serde_json::Value = serde_json::from_slice(&delta.to_bytes()).unwrap();
        assert_eq!(decoded["v"], STATE_VERSION);
        assert_eq!(decoded["slots"][0]["i"], 2);
        assert_eq!(decoded["slots"][0]["seq"], 4);
        assert_eq!(decoded["slots"][0]["entry"]["value"], -42);
        assert!(decoded["slots"][0]["sig"].is_string());
    }

    #[test]
    fn summary_is_deterministic_and_small() {
        let key = test_key();
        let state = populated_state(&key);
        let first = summarize(&state);
        let second = summarize(&state);
        assert_eq!(first.as_ref(), second.as_ref());
        assert!(first.size() < state.to_bytes().len());
    }

    #[test]
    fn delta_to_converged_peer_is_literally_empty() {
        let key = test_key();
        let state = populated_state(&key);
        let summary = summarize(&state);
        let delta = delta_from(&state, &summary);
        assert_eq!(delta.size(), 0);
    }

    #[test]
    fn delta_summary_round_trip() {
        let key = test_key();
        let from = StateV1::empty();
        let to = populated_state(&key);

        let delta = delta_from(&to, &summarize(&from));
        assert!(delta.size() > 0);

        let synced = NumberContract::update_state(
            params(&key),
            State::from(from.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), to.to_bytes().as_slice());

        // And now the peer is converged.
        let reverse = delta_from(&to, &summarize(&to));
        assert_eq!(reverse.size(), 0);
    }

    #[test]
    fn empty_summary_requests_the_whole_board() {
        // A brand-new subscriber presents an empty summary. Failing that with
        // InvalidDelta aborts the subscription/notification, so it must yield
        // the full board instead.
        let key = test_key();
        let state = populated_state(&key);
        let empty = StateSummary::from(vec![]);
        let delta = delta_from(&state, &empty);
        assert!(delta.size() > 0);

        let synced = NumberContract::update_state(
            params(&key),
            State::from(StateV1::empty().to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), state.to_bytes().as_slice());
    }

    #[test]
    fn undecodable_summary_falls_back_to_the_whole_board() {
        let key = test_key();
        let state = populated_state(&key);
        let junk = StateSummary::from(b"not a summary".to_vec());
        let delta = delta_from(&state, &junk);
        assert!(delta.size() > 0);
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(
            parsed.slots.len(),
            state.slots.iter().filter(|s| s.seq > 0).count()
        );
    }

    #[test]
    fn tombstone_round_trips_through_delta() {
        let key = test_key();
        let mut before = StateV1::empty();
        before.slots[2] = signed_slot(&key, 2, 4, Some(sample_entry()));

        let mut after = before.clone();
        after.slots[2] = signed_slot(&key, 2, 5, None);

        let delta = delta_from(&after, &summarize(&before));
        let synced = NumberContract::update_state(
            params(&key),
            State::from(before.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), after.to_bytes().as_slice());

        // The tombstone defeats the old value even if it arrives again.
        let stale = NumberContract::update_state(
            params(&key),
            State::from(synced.as_ref().to_vec()),
            vec![UpdateData::State(State::from(before.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(stale.as_ref(), after.to_bytes().as_slice());
    }

    #[test]
    fn equal_seq_different_entry_resolves_by_signature_bytes() {
        let key = test_key();
        let entry_a = Entry {
            value: 1,
            label: Some("a".into()),
            unit: None,
            note: None,
        };
        let entry_b = Entry {
            value: 2,
            label: Some("b".into()),
            unit: None,
            note: None,
        };
        let slot_a = signed_slot(&key, 0, 3, Some(entry_a));
        let slot_b = signed_slot(&key, 0, 3, Some(entry_b));

        let expected = if signature_bytes(&slot_a) > signature_bytes(&slot_b) {
            slot_a.clone()
        } else {
            slot_b.clone()
        };

        let state_a = state_of(vec![
            slot_a,
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
        ]);
        let state_b = state_of(vec![
            slot_b,
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
        ]);

        assert_eq!(merged(&state_a, &state_b).slots[0], expected);
        assert_eq!(merged(&state_b, &state_a).slots[0], expected);
        assert_eq!(
            merged(&state_a, &state_b).to_bytes(),
            merged(&state_b, &state_a).to_bytes()
        );
        assert!(
            merged(&state_a, &state_b)
                .validate(&key.verifying_key())
                .is_ok()
        );
    }

    #[test]
    fn delta_validation_rejects_out_of_range_index() {
        let key = test_key();
        let slot = signed_slot(&key, 0, 1, Some(sample_entry()));
        let delta = Delta {
            v: STATE_VERSION,
            slots: vec![DeltaSlot::from_slot(8, &slot)],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV1::empty().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        );
        assert!(err.is_err());
    }

    // ---- property tests ---------------------------------------------------

    #[derive(Clone, Debug)]
    enum SlotSpec {
        Empty,
        Tombstone(u64),
        Value(u64, Entry),
    }

    fn arb_ascii(max: usize) -> impl Strategy<Value = String> {
        proptest::collection::vec(proptest::char::range('a', 'z'), 0..=max)
            .prop_map(|chars| chars.into_iter().collect())
    }

    fn arb_entry() -> impl Strategy<Value = Entry> {
        (
            any::<i64>(),
            prop::option::of(arb_ascii(MAX_LABEL_BYTES)),
            prop::option::of(arb_ascii(MAX_UNIT_BYTES)),
            prop::option::of(arb_ascii(100)),
        )
            .prop_map(|(value, label, unit, note)| Entry {
                value,
                label,
                unit,
                note,
            })
    }

    fn arb_slot_spec() -> impl Strategy<Value = SlotSpec> {
        prop_oneof![
            Just(SlotSpec::Empty),
            (1u64..=u64::MAX).prop_map(SlotSpec::Tombstone),
            ((1u64..=u64::MAX), arb_entry()).prop_map(|(seq, entry)| SlotSpec::Value(seq, entry)),
        ]
    }

    fn arb_state() -> impl Strategy<Value = StateV1> {
        proptest::collection::vec(arb_slot_spec(), SLOT_COUNT).prop_map(|specs| {
            let key = test_key();
            let slots = std::array::from_fn(|index| match &specs[index] {
                SlotSpec::Empty => Slot::empty(),
                SlotSpec::Tombstone(seq) => signed_slot(&key, index as u8, *seq, None),
                SlotSpec::Value(seq, entry) => {
                    signed_slot(&key, index as u8, *seq, Some(entry.clone()))
                }
            });
            StateV1 {
                v: STATE_VERSION,
                slots,
            }
        })
    }

    proptest! {
        #[test]
        fn merge_is_commutative(a in arb_state(), b in arb_state()) {
            let ab = merged(&a, &b);
            let ba = merged(&b, &a);
            prop_assert_eq!(ab.to_bytes(), ba.to_bytes());
        }

        #[test]
        fn merge_is_associative(a in arb_state(), b in arb_state(), c in arb_state()) {
            let ab_c = merged(&merged(&a, &b), &c);
            let a_bc = merged(&a, &merged(&b, &c));
            prop_assert_eq!(ab_c.to_bytes(), a_bc.to_bytes());
        }

        #[test]
        fn merge_is_idempotent(a in arb_state()) {
            prop_assert_eq!(merged(&a, &a).to_bytes(), a.to_bytes());
        }

        #[test]
        fn merge_absorbs_redelivery(a in arb_state(), b in arb_state()) {
            let once = merged(&a, &b);
            let twice = merged(&once, &b);
            prop_assert_eq!(once.to_bytes(), twice.to_bytes());
        }

        #[test]
        fn merge_identity(a in arb_state()) {
            let empty = StateV1::empty();
            prop_assert_eq!(merged(&a, &empty).to_bytes(), a.to_bytes());
            prop_assert_eq!(merged(&empty, &a).to_bytes(), a.to_bytes());
        }

        #[test]
        fn merged_states_stay_valid(a in arb_state(), b in arb_state()) {
            let key = test_key();
            prop_assert!(merged(&a, &b).validate(&key.verifying_key()).is_ok());
        }
    }
}
