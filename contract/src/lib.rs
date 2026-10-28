//! `number-contract` — one board per owner, with eight number slots, a signed
//! address book and at most one signed parent.
//!
//! The contract is parameterised by the owner's raw 32-byte Ed25519 verifying
//! key. Every non-empty (`seq > 0`) slot, contacts record and parent record
//! carries an Ed25519 signature over the canonical bytes defined in
//! `DESIGN.md` §2. State is a fixed-size array of eight slots plus one contacts
//! record and one parent record, so encoding is deterministic and the merge is
//! a component-wise maximum; there are no maps, caps or removals in state.
//!
//! The contract never reads the host clock and never uses randomness.

use ed25519_dalek::{Signature, VerifyingKey};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};

/// Number of slots in a board. This is fixed by the design.
pub const SLOT_COUNT: usize = 8;

/// Maximum number of contacts in the address book.
pub const MAX_CONTACTS: usize = 64;
/// Maximum length of a contact label in UTF-8 bytes.
pub const MAX_CONTACT_LABEL_BYTES: usize = 64;
/// Maximum length of `Entry::unit` in UTF-8 bytes.
pub const MAX_UNIT_BYTES: usize = 16;
/// Maximum length of `Entry::note` in UTF-8 bytes.
pub const MAX_NOTE_BYTES: usize = 512;

/// Length of a `userId`/`contact` hex string (32 raw bytes).
pub const USER_ID_HEX_LEN: usize = 64;

/// State schema version written to (and required in) every wire object.
pub const STATE_VERSION: u8 = 3;

/// Domain prefix of the canonical slot signing bytes. Unchanged from v2 so a v2
/// state's signatures keep validating after the client upgrades it to v3;
/// changing this is a breaking state change; see `DESIGN.md` §2.
pub const SIGNING_DOMAIN_SLOT: &[u8] = b"number:v2:slot";

/// Domain prefix of the canonical contacts signing bytes. Unchanged from v2.
pub const SIGNING_DOMAIN_CONTACTS: &[u8] = b"number:v2:contacts";

/// Domain prefix of the canonical parent signing bytes.
pub const SIGNING_DOMAIN_PARENT: &[u8] = b"number:v3:parent";

/// Whether `value` is exactly 64 lowercase hexadecimal characters (32 bytes).
pub fn validate_contact(value: &str) -> bool {
    value.len() == USER_ID_HEX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One address-book entry. Both fields are covered by the contacts signature.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Contact {
    pub label: String,
    #[serde(rename = "userId")]
    pub user_id: String,
}

impl Contact {
    /// Whether the label is non-empty and within bounds and `userId` is a
    /// well-formed Ed25519 public key encoding.
    pub fn is_valid(&self) -> bool {
        !self.label.is_empty()
            && self.label.len() <= MAX_CONTACT_LABEL_BYTES
            && validate_contact(&self.user_id)
    }
}

/// The signed address book. `seq == 0` is the empty record (no entries, no
/// signature); `seq > 0` with an empty `entries` list is a legal tombstone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Contacts {
    pub seq: u64,
    pub entries: Vec<Contact>,
    pub sig: Option<String>,
}

impl Contacts {
    /// The initial, empty address book.
    pub fn empty() -> Self {
        Self {
            seq: 0,
            entries: Vec::new(),
            sig: None,
        }
    }

    /// Whether this record is valid under `key`.
    ///
    /// Covers the seq-0 invariant, the contact count and field bounds,
    /// uniqueness of both `userId` and exact `label`, and the Ed25519 signature
    /// over the canonical bytes.
    pub fn is_valid(&self, key: &VerifyingKey) -> bool {
        if self.seq == 0 {
            return self.entries.is_empty() && self.sig.is_none();
        }
        if self.entries.len() > MAX_CONTACTS {
            return false;
        }
        for (index, contact) in self.entries.iter().enumerate() {
            if !contact.is_valid() {
                return false;
            }
            let earlier = &self.entries[..index];
            if earlier.iter().any(|other| other.user_id == contact.user_id)
                || earlier.iter().any(|other| other.label == contact.label)
            {
                return false;
            }
        }
        let Some(signature) = self.sig.as_deref().and_then(parse_signature) else {
            return false;
        };
        let bytes = contacts_signing_bytes(self.seq, &self.entries);
        key.verify_strict(&bytes, &signature).is_ok()
    }
}

/// The signed parent link. `seq == 0` is the never-set record (no parent and no
/// signature); `seq > 0` with `user_id == None` is a legal tombstone (the parent
/// was cleared at that sequence).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Parent {
    pub seq: u64,
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    pub sig: Option<String>,
}

impl Parent {
    /// The initial, empty parent record.
    pub fn empty() -> Self {
        Self {
            seq: 0,
            user_id: None,
            sig: None,
        }
    }

    /// Whether this record is valid under the owner `key`.
    ///
    /// Covers the seq-0 invariant, the user id format, rejection of a
    /// self-parent (the board owner's own key), and the Ed25519 signature over
    /// the canonical bytes.
    pub fn is_valid(&self, key: &VerifyingKey) -> bool {
        if self.seq == 0 {
            return self.user_id.is_none() && self.sig.is_none();
        }
        if let Some(user_id) = self.user_id.as_deref() {
            if !validate_contact(user_id) {
                return false;
            }
            if user_id == hex::encode(key.to_bytes()) {
                return false;
            }
        }
        let Some(signature) = self.sig.as_deref().and_then(parse_signature) else {
            return false;
        };
        let bytes = parent_signing_bytes(self.seq, self.user_id.as_deref());
        key.verify_strict(&bytes, &signature).is_ok()
    }
}

/// A single slot value. Every field is covered by the slot signature.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// A count of hundredths ("cents"). Any i64 is valid; absent defaults to 0.
    #[serde(default)]
    pub value: i64,
    /// The contact's stable `userId` (64 lowercase hex chars). Mandatory.
    pub contact: String,
    /// Optional; `null` and absent decode identically and encode as `null`.
    #[serde(default)]
    pub unit: Option<String>,
    /// Optional; `null` and absent decode identically and encode as `null`.
    #[serde(default)]
    pub note: Option<String>,
}

impl Entry {
    /// Whether the contact id and optional metadata are within the schema
    /// bounds from §2.
    pub fn within_bounds(&self) -> bool {
        validate_contact(&self.contact)
            && self
                .unit
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_UNIT_BYTES)
            && self
                .note
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_NOTE_BYTES)
    }

    /// Alias for [`Entry::within_bounds`].
    pub fn is_valid(&self) -> bool {
        self.within_bounds()
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
    /// Covers the seq-0 invariant, entry bounds, signature hex form and the
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
pub struct StateV3 {
    pub v: u8,
    pub parent: Parent,
    pub contacts: Contacts,
    pub slots: [Slot; SLOT_COUNT],
}

impl StateV3 {
    /// An all-empty board.
    pub fn empty() -> Self {
        Self {
            v: STATE_VERSION,
            parent: Parent::empty(),
            contacts: Contacts::empty(),
            slots: std::array::from_fn(|_| Slot::empty()),
        }
    }

    /// Decode JSON state bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, ContractError> {
        serde_json::from_slice(bytes).map_err(|_| ContractError::InvalidState)
    }

    /// Encode state deterministically as JSON.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("StateV3 serialization cannot fail")
    }

    /// Validate version, parent, contacts, slot count (enforced by the array
    /// type), the seq-0 invariants, field bounds and every signature under
    /// `key`.
    pub fn validate(&self, key: &VerifyingKey) -> Result<(), ContractError> {
        if self.v != STATE_VERSION {
            return Err(ContractError::InvalidState);
        }
        if !self.parent.is_valid(key) {
            return Err(ContractError::InvalidState);
        }
        if !self.contacts.is_valid(key) {
            return Err(ContractError::InvalidState);
        }
        for (index, slot) in self.slots.iter().enumerate() {
            if !slot.is_valid(index as u8, key) {
                return Err(ContractError::InvalidState);
            }
        }
        Ok(())
    }

    /// Merge `other` component-wise. This is a maximum over the total order from
    /// §3/§5, so it is associative, commutative, idempotent and absorbing.
    pub fn merge(&mut self, other: &Self) {
        self.parent = merge_parent(&self.parent, &other.parent);
        self.contacts = merge_contacts(&self.contacts, &other.contacts);
        for (index, other_slot) in other.slots.iter().enumerate() {
            self.slots[index] = merge_slot(&self.slots[index], other_slot);
        }
    }
}

/// Parent merge: higher `seq` wins; on equal `seq` the lexicographically
/// greater signature bytes win.
fn merge_parent(a: &Parent, b: &Parent) -> Parent {
    if a.seq > b.seq {
        return a.clone();
    }
    if b.seq > a.seq {
        return b.clone();
    }
    if parent_signature_bytes(a) >= parent_signature_bytes(b) {
        a.clone()
    } else {
        b.clone()
    }
}

/// Contacts merge: higher `seq` wins; on equal `seq` the lexicographically
/// greater signature bytes win.
fn merge_contacts(a: &Contacts, b: &Contacts) -> Contacts {
    if a.seq > b.seq {
        return a.clone();
    }
    if b.seq > a.seq {
        return b.clone();
    }
    if contacts_signature_bytes(a) >= contacts_signature_bytes(b) {
        a.clone()
    } else {
        b.clone()
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

/// The slot signature field as bytes. Empty slots (and any malformed sig, which
/// the validators reject before merging) compare as all-zero bytes.
fn signature_bytes(slot: &Slot) -> [u8; 64] {
    slot.sig
        .as_deref()
        .and_then(|sig| {
            let bytes = hex::decode(sig).ok()?;
            bytes.try_into().ok()
        })
        .unwrap_or([0; 64])
}

/// The contacts signature field as bytes. An empty record (and any malformed
/// sig, which the validators reject before merging) compares as all-zero bytes.
fn contacts_signature_bytes(contacts: &Contacts) -> [u8; 64] {
    contacts
        .sig
        .as_deref()
        .and_then(|sig| {
            let bytes = hex::decode(sig).ok()?;
            bytes.try_into().ok()
        })
        .unwrap_or([0; 64])
}

/// The parent signature field as bytes. An empty record (and any malformed sig,
/// which the validators reject before merging) compares as all-zero bytes.
fn parent_signature_bytes(parent: &Parent) -> [u8; 64] {
    parent
        .sig
        .as_deref()
        .and_then(|sig| {
            let bytes = hex::decode(sig).ok()?;
            bytes.try_into().ok()
        })
        .unwrap_or([0; 64])
}

/// Canonical parent signing bytes, hand-built exactly as specified in
/// `DESIGN.md` §2.
///
/// ```text
/// b"number:v3:parent"
/// || seq: u64 little-endian
/// || tag: u8                 // 0 = no parent, 1 = parent set
/// // only when tag == 1:
/// || userId: 32 raw bytes
/// ```
///
/// An empty parent at `seq > 0` signs `tag = 0`; `seq == 0` is never signed.
pub fn parent_signing_bytes(seq: u64, user_id: Option<&str>) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(SIGNING_DOMAIN_PARENT);
    out.extend_from_slice(&seq.to_le_bytes());
    match user_id {
        None => out.push(0),
        Some(user_id) => {
            out.push(1);
            out.extend_from_slice(&contact_raw(user_id));
        }
    }
    out
}

/// Canonical slot signing bytes, hand-built exactly as specified in
/// `DESIGN.md` §2.
///
/// ```text
/// b"number:v2:slot"
/// || slot_index: u8
/// || seq: u64 little-endian
/// || entry_tag: u8            // 0 = None, 1 = Some
/// // only when entry_tag == 1:
/// || value: i64 little-endian
/// || contact: 32 raw bytes
/// || unit_len: u32 LE || unit bytes
/// || note_len: u32 LE || note bytes
/// ```
///
/// `None` optional strings encode as length 0.
pub fn signing_bytes(slot_index: u8, seq: u64, entry: Option<&Entry>) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(SIGNING_DOMAIN_SLOT);
    out.push(slot_index);
    out.extend_from_slice(&seq.to_le_bytes());
    match entry {
        None => out.push(0),
        Some(entry) => {
            out.push(1);
            out.extend_from_slice(&entry.value.to_le_bytes());
            out.extend_from_slice(&contact_raw(&entry.contact));
            push_optional_string(&mut out, entry.unit.as_deref());
            push_optional_string(&mut out, entry.note.as_deref());
        }
    }
    out
}

/// Canonical contacts signing bytes, hand-built exactly as specified in
/// `DESIGN.md` §2.
///
/// ```text
/// b"number:v2:contacts"
/// || seq: u64 little-endian
/// || count: u32 LE
/// || for each entry, in order:
///      label_len: u32 LE || label bytes
///      || userId: 32 raw bytes
/// ```
pub fn contacts_signing_bytes(seq: u64, entries: &[Contact]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(SIGNING_DOMAIN_CONTACTS);
    out.extend_from_slice(&seq.to_le_bytes());
    let count = u32::try_from(entries.len()).expect("contact count is bounded by MAX_CONTACTS");
    out.extend_from_slice(&count.to_le_bytes());
    for contact in entries {
        let label = contact.label.as_bytes();
        let label_len =
            u32::try_from(label.len()).expect("label bounds keep lengths below u32::MAX");
        out.extend_from_slice(&label_len.to_le_bytes());
        out.extend_from_slice(label);
        out.extend_from_slice(&contact_raw(&contact.user_id));
    }
    out
}

/// Decode a 64-hex-character user id into its raw 32 bytes. Invalid input maps
/// to all-zero bytes; callers validate before signing or verifying.
fn contact_raw(value: &str) -> [u8; 32] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 32])
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

/// Summary of one slot or the contacts record (§2.6):
/// `[seq, first 16 bytes of BLAKE3(signing bytes)]`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SlotSummary(pub u64, pub String);

/// State summary (§2.6). One parent pair, one contacts pair plus exactly eight
/// slot pairs; the digest is all-zero for an empty record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub v: u8,
    pub parent: SlotSummary,
    pub contacts: SlotSummary,
    pub slots: [SlotSummary; SLOT_COUNT],
}

impl Summary {
    /// Build the summary for `state`.
    pub fn of(state: &StateV3) -> Self {
        let parent = if state.parent.seq == 0 {
            SlotSummary(0, hex::encode([0u8; 16]))
        } else {
            let digest = digest16(&parent_signing_bytes(
                state.parent.seq,
                state.parent.user_id.as_deref(),
            ));
            SlotSummary(state.parent.seq, hex::encode(digest))
        };
        let contacts = if state.contacts.seq == 0 {
            SlotSummary(0, hex::encode([0u8; 16]))
        } else {
            let digest = digest16(&contacts_signing_bytes(
                state.contacts.seq,
                &state.contacts.entries,
            ));
            SlotSummary(state.contacts.seq, hex::encode(digest))
        };
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
            parent,
            contacts,
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
        let parent_digest = summary_digest(&summary.parent.1)?;
        if summary.parent.0 == 0 && parent_digest != [0u8; 16] {
            return Err(ContractError::InvalidDelta);
        }
        let contacts_digest = summary_digest(&summary.contacts.1)?;
        if summary.contacts.0 == 0 && contacts_digest != [0u8; 16] {
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

/// One changed slot in a delta (§2.7).
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

/// Validated delta payload: the optional parent and contacts records plus
/// changed slots.
type ValidatedDelta = (Option<Parent>, Option<Contacts>, Vec<(u8, Slot)>);

/// State delta (§2.7).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Delta {
    pub v: u8,
    /// `null`/absent when the parent record is unchanged.
    #[serde(default)]
    pub parent: Option<Parent>,
    /// `null`/absent when the contacts record is unchanged.
    #[serde(default)]
    pub contacts: Option<Contacts>,
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

    /// Validate the contacts record and every slot under `key`, returning them
    /// for merging. Validation is all-or-nothing before anything is applied.
    fn validated(&self, key: &VerifyingKey) -> Result<ValidatedDelta, ContractError> {
        if self.v != STATE_VERSION {
            return Err(ContractError::InvalidDelta);
        }
        let parent = match &self.parent {
            None => None,
            Some(parent) => {
                if !parent.is_valid(key) {
                    return Err(ContractError::InvalidDelta);
                }
                Some(parent.clone())
            }
        };
        let contacts = match &self.contacts {
            None => None,
            Some(contacts) => {
                if !contacts.is_valid(key) {
                    return Err(ContractError::InvalidDelta);
                }
                Some(contacts.clone())
            }
        };
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
        Ok((parent, contacts, slots))
    }
}

fn owner_key(parameters: &Parameters<'_>) -> Result<VerifyingKey, ContractError> {
    let bytes: [u8; 32] = parameters
        .as_ref()
        .try_into()
        .map_err(|_| ContractError::Other("parameters must be 32 bytes".into()))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| ContractError::Other("parameters are not a valid Ed25519 point".into()))
}

/// Staged, already-validated incoming update.
enum Incoming {
    Full(Box<StateV3>),
    Delta {
        parent: Option<Parent>,
        contacts: Option<Contacts>,
        slots: Vec<(u8, Slot)>,
    },
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
        let Ok(state) = StateV3::decode(state.as_ref()) else {
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
        let mut current = StateV3::decode(state.as_ref())?;
        current.validate(&key)?;

        // Stage and validate everything before mutating. A single invalid
        // contact or slot rejects the whole update (single writer, so atomicity
        // is correct).
        let mut staged = Vec::with_capacity(data.len());
        for item in &data {
            match item {
                UpdateData::State(incoming) => {
                    let incoming = StateV3::decode(incoming.as_ref())?;
                    incoming.validate(&key)?;
                    staged.push(Incoming::Full(Box::new(incoming)));
                }
                UpdateData::Delta(delta) => {
                    let delta = Delta::decode(delta.as_ref())?;
                    let (parent, contacts, slots) = delta.validated(&key)?;
                    staged.push(Incoming::Delta {
                        parent,
                        contacts,
                        slots,
                    });
                }
                UpdateData::StateAndDelta {
                    state: incoming,
                    delta,
                } => {
                    let incoming = StateV3::decode(incoming.as_ref())?;
                    incoming.validate(&key)?;
                    let delta = Delta::decode(delta.as_ref())?;
                    let (parent, contacts, slots) = delta.validated(&key)?;
                    staged.push(Incoming::Full(Box::new(incoming)));
                    staged.push(Incoming::Delta {
                        parent,
                        contacts,
                        slots,
                    });
                }
                // Related contracts are not part of this design.
                _ => {}
            }
        }

        for incoming in staged {
            match incoming {
                Incoming::Full(incoming) => current.merge(&incoming),
                Incoming::Delta {
                    parent,
                    contacts,
                    slots,
                } => {
                    if let Some(parent) = parent {
                        current.parent = merge_parent(&current.parent, &parent);
                    }
                    if let Some(contacts) = contacts {
                        current.contacts = merge_contacts(&current.contacts, &contacts);
                    }
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
        let state = StateV3::decode(state.as_ref())?;
        Ok(StateSummary::from(Summary::of(&state).to_bytes()))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = StateV3::decode(state.as_ref())?;
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

        let local_parent_digest = if state.parent.seq == 0 {
            [0u8; 16]
        } else {
            digest16(&parent_signing_bytes(
                state.parent.seq,
                state.parent.user_id.as_deref(),
            ))
        };
        let include_parent = match &summary {
            None => state.parent.seq > 0,
            Some(summary) => {
                let remote_digest = summary_digest(&summary.parent.1)?;
                state.parent.seq > summary.parent.0
                    || (state.parent.seq == summary.parent.0
                        && local_parent_digest != remote_digest)
            }
        };

        let local_contacts_digest = if state.contacts.seq == 0 {
            [0u8; 16]
        } else {
            digest16(&contacts_signing_bytes(
                state.contacts.seq,
                &state.contacts.entries,
            ))
        };
        let include_contacts = match &summary {
            None => state.contacts.seq > 0,
            Some(summary) => {
                let remote_digest = summary_digest(&summary.contacts.1)?;
                state.contacts.seq > summary.contacts.0
                    || (state.contacts.seq == summary.contacts.0
                        && local_contacts_digest != remote_digest)
            }
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

        if !include_parent && !include_contacts && slots.is_empty() {
            // The unambiguous "converged" answer (§2.7).
            return Ok(StateDelta::from(vec![]));
        }
        let delta = Delta {
            v: STATE_VERSION,
            parent: if include_parent {
                Some(state.parent.clone())
            } else {
                None
            },
            contacts: if include_contacts {
                Some(state.contacts.clone())
            } else {
                None
            },
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
    const CONTACT_11: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const CONTACT_22: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_SEED)
    }

    fn contact(label: &str, user_id: &str) -> Contact {
        Contact {
            label: label.into(),
            user_id: user_id.into(),
        }
    }

    fn signed_slot(key: &SigningKey, index: u8, seq: u64, entry: Option<Entry>) -> Slot {
        let signature = key.sign(&signing_bytes(index, seq, entry.as_ref()));
        Slot {
            seq,
            entry,
            sig: Some(hex::encode(signature.to_bytes())),
        }
    }

    fn signed_contacts(key: &SigningKey, seq: u64, entries: Vec<Contact>) -> Contacts {
        let signature = key.sign(&contacts_signing_bytes(seq, &entries));
        Contacts {
            seq,
            entries,
            sig: Some(hex::encode(signature.to_bytes())),
        }
    }

    fn signed_parent(key: &SigningKey, seq: u64, user_id: Option<&str>) -> Parent {
        let signature = key.sign(&parent_signing_bytes(seq, user_id));
        Parent {
            seq,
            user_id: user_id.map(str::to_owned),
            sig: Some(hex::encode(signature.to_bytes())),
        }
    }

    fn params(key: &SigningKey) -> Parameters<'static> {
        Parameters::from(key.verifying_key().to_bytes().to_vec())
    }

    fn state_of(slots: Vec<Slot>, contacts: Contacts) -> StateV3 {
        let slots: [Slot; SLOT_COUNT] = slots
            .try_into()
            .expect("test helper always supplies eight slots");
        StateV3 {
            v: STATE_VERSION,
            parent: Parent::empty(),
            contacts,
            slots,
        }
    }

    fn state_with_slots(slots: Vec<Slot>) -> StateV3 {
        state_of(slots, Contacts::empty())
    }

    fn merged(a: &StateV3, b: &StateV3) -> StateV3 {
        let mut result = a.clone();
        result.merge(b);
        result
    }

    fn sample_entry() -> Entry {
        Entry {
            value: -42,
            contact: CONTACT_11.into(),
            unit: Some("kg".into()),
            note: None,
        }
    }

    fn populated_state(key: &SigningKey) -> StateV3 {
        let mut state = StateV3::empty();
        state.parent = signed_parent(key, 2, Some(CONTACT_22));
        state.contacts = signed_contacts(key, 1, vec![contact("Alice", CONTACT_11)]);
        state.slots[2] = signed_slot(key, 2, 4, Some(sample_entry()));
        state.slots[5] = signed_slot(key, 5, 1, None); // tombstone
        state.slots[7] = signed_slot(
            key,
            7,
            9,
            Some(Entry {
                value: i64::MIN,
                contact: CONTACT_22.into(),
                unit: Some("m".into()),
                note: Some("hello".into()),
            }),
        );
        state
    }

    // ---- canonical signing bytes -----------------------------------------

    #[test]
    fn golden_slot_signing_bytes_are_pinned() {
        let entry = Entry {
            value: 12,
            contact: CONTACT_11.into(),
            unit: None,
            note: None,
        };
        let bytes = signing_bytes(3, 7, Some(&entry));
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76323a736c6f74030700000000000000010c0000000000000011111111111111111111111111111111111111111111111111111111111111110000000000000000"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "d6f77f8b222a3ee76101db6e6f662e7c"
        );

        // The empty/tombstone form is a different fixed vector.
        assert_eq!(
            hex::encode(signing_bytes(5, 1, None)),
            "6e756d6265723a76323a736c6f7405010000000000000000"
        );
    }

    #[test]
    fn golden_contacts_signing_bytes_are_pinned() {
        let entries = vec![contact("Alice", CONTACT_11)];
        let bytes = contacts_signing_bytes(1, &entries);
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76323a636f6e746163747301000000000000000100000005000000416c6963651111111111111111111111111111111111111111111111111111111111111111"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "415fee80ba4f302cac4cd169a7f075a4"
        );

        // An empty list at seq > 0 signs count = 0.
        assert_eq!(
            hex::encode(contacts_signing_bytes(2, &[])),
            "6e756d6265723a76323a636f6e7461637473020000000000000000000000"
        );
    }

    #[test]
    fn golden_parent_signing_bytes_are_pinned() {
        let set = parent_signing_bytes(1, Some(CONTACT_11));
        assert_eq!(
            hex::encode(&set),
            "6e756d6265723a76333a706172656e740100000000000000011111111111111111111111111111111111111111111111111111111111111111"
        );
        assert_eq!(
            hex::encode(digest16(&set)),
            "a3b70e503d1951bb363f6fbf310d4782"
        );

        let cleared = parent_signing_bytes(1, None);
        assert_eq!(
            hex::encode(&cleared),
            "6e756d6265723a76333a706172656e74010000000000000000"
        );
        assert_eq!(
            hex::encode(digest16(&cleared)),
            "3b38efbfcc7bd18dce1d5e265151e9f0"
        );

        // `seq == 0` is never signed, but the encoder is still deterministic.
        let mut zero = SIGNING_DOMAIN_PARENT.to_vec();
        zero.extend_from_slice(&0u64.to_le_bytes());
        zero.push(0);
        assert_eq!(parent_signing_bytes(0, None), zero);
    }

    /// Migrations safety: the v3 client upgrades a v2 state to v3 by adding an
    /// empty parent. The v2 slot/contacts signing domains are unchanged, so the
    /// old signatures must still validate under a v3 contract.
    #[test]
    fn v2_signed_slots_and_contacts_validate_with_an_empty_v3_parent() {
        let key = test_key();
        let verifying = key.verifying_key();
        let mut state = StateV3::empty();
        // Produced by the v2 delegate for seed [7u8; 32]:
        // contacts seq 1 `Alice`, slot 3 seq 7 value 12.
        state.contacts = Contacts {
            seq: 1,
            entries: vec![contact("Alice", CONTACT_11)],
            sig: Some(
                "c23847c3587eb9d295db216d0933aa592a54d5374232efa456c4e0cf64b5194da1a58aa0939fbf5a6bef2024ff8ac152ea75afe3a9a1cc655a4979de43cb0906"
                    .into(),
            ),
        };
        state.slots[3] = Slot {
            seq: 7,
            entry: Some(Entry {
                value: 12,
                contact: CONTACT_11.into(),
                unit: None,
                note: None,
            }),
            sig: Some(
                "f666bc2cac7ec8a21df38dfde44d09d80a8318400850c9e6bd72173eafbc9d68106ddce7a122f85bbb9253d13d95b9accad3e4bad3a0ee24fcf424fe17088201"
                    .into(),
            ),
        };

        assert_eq!(state.v, 3);
        assert_eq!(state.parent, Parent::empty());
        assert!(state.validate(&verifying).is_ok());
        assert_eq!(
            NumberContract::validate_state(
                params(&key),
                State::from(state.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Valid
        );
    }

    #[test]
    fn delegate_golden_signature_verifies_under_contract_rules() {
        // Cross-component pin: this signature is produced by `number-delegate`
        // (seed [7u8; 32], slot 3, seq 7, the §2.5 golden payload). It must
        // verify here or the two canonical encoders have drifted apart.
        let pubkey =
            hex::decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
                .expect("golden pubkey is hex");
        let verifying_key =
            VerifyingKey::from_bytes(&pubkey.try_into().expect("golden pubkey is 32 bytes"))
                .expect("golden pubkey is a valid point");
        let slot = Slot {
            seq: 7,
            entry: Some(Entry {
                value: 12,
                contact: CONTACT_11.into(),
                unit: None,
                note: None,
            }),
            sig: Some(
                "f666bc2cac7ec8a21df38dfde44d09d80a8318400850c9e6bd72173eafbc9d68106ddce7a122f85bbb9253d13d95b9accad3e4bad3a0ee24fcf424fe17088201"
                    .into(),
            ),
        };
        assert!(slot.is_valid(3, &verifying_key));
    }

    #[test]
    fn delegate_golden_contacts_signature_verifies_under_contract_rules() {
        let pubkey =
            hex::decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
                .expect("golden pubkey is hex");
        let verifying_key =
            VerifyingKey::from_bytes(&pubkey.try_into().expect("golden pubkey is 32 bytes"))
                .expect("golden pubkey is a valid point");
        let contacts = Contacts {
            seq: 1,
            entries: vec![contact("Alice", CONTACT_11)],
            sig: Some(
                "c23847c3587eb9d295db216d0933aa592a54d5374232efa456c4e0cf64b5194da1a58aa0939fbf5a6bef2024ff8ac152ea75afe3a9a1cc655a4979de43cb0906"
                    .into(),
            ),
        };
        assert!(contacts.is_valid(&verifying_key));
    }

    #[test]
    fn delegate_golden_parent_signature_verifies_under_contract_rules() {
        // Cross-component pin: this signature is produced by `number-delegate`
        // (seed [7u8; 32], parent seq 1, userId 0x11 × 32). It must verify here
        // or the two canonical encoders have drifted apart.
        let pubkey =
            hex::decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
                .expect("golden pubkey is hex");
        let verifying_key =
            VerifyingKey::from_bytes(&pubkey.try_into().expect("golden pubkey is 32 bytes"))
                .expect("golden pubkey is a valid point");
        let parent = Parent {
            seq: 1,
            user_id: Some(CONTACT_11.into()),
            sig: Some(
                "83620d873b5179b726f2aab882083d4d74fa6eee90726ada5b44b74d1d3f48e2e6b31dac5b31142febeb1d6505e426d659c0907adf3110cdddb3984b0bc80400"
                    .into(),
            ),
        };
        assert!(parent.is_valid(&verifying_key));
    }

    #[test]
    fn optional_strings_encode_as_empty_length() {
        let with_none = Entry {
            value: 1,
            contact: CONTACT_11.into(),
            unit: None,
            note: None,
        };
        let with_empty = Entry {
            value: 1,
            contact: CONTACT_11.into(),
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
    fn tampering_with_contact_fails() {
        let key = test_key();
        let slot = signed_slot(&key, 3, 7, Some(sample_entry()));
        let mut tampered = slot;
        tampered.entry.as_mut().unwrap().contact = CONTACT_22.into();
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
    fn contacts_seq_zero_requires_empty_entries_and_null_sig() {
        let key = test_key();
        let verifying = key.verifying_key();

        assert!(Contacts::empty().is_valid(&verifying));

        let with_entry = Contacts {
            seq: 0,
            entries: vec![contact("Alice", CONTACT_11)],
            sig: None,
        };
        assert!(!with_entry.is_valid(&verifying));

        let stray_signature = Contacts {
            seq: 0,
            entries: Vec::new(),
            sig: Some(hex::encode([1u8; 64])),
        };
        assert!(!stray_signature.is_valid(&verifying));
    }

    #[test]
    fn metadata_bounds_are_inclusive() {
        let key = test_key();
        let verifying = key.verifying_key();

        let at_limit = Entry {
            value: 0,
            contact: CONTACT_11.into(),
            unit: Some("u".repeat(MAX_UNIT_BYTES)),
            note: Some("n".repeat(MAX_NOTE_BYTES)),
        };
        assert!(signed_slot(&key, 0, 1, Some(at_limit)).is_valid(0, &verifying));

        for over in [
            Entry {
                value: 0,
                contact: CONTACT_11.into(),
                unit: Some("u".repeat(MAX_UNIT_BYTES + 1)),
                note: None,
            },
            Entry {
                value: 0,
                contact: CONTACT_11.into(),
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
        // 8 * 2 = 16 bytes: allowed even though it is only 8 characters.
        let fits = Entry {
            value: 0,
            contact: CONTACT_11.into(),
            unit: Some("é".repeat(MAX_UNIT_BYTES / 2)),
            note: None,
        };
        assert!(signed_slot(&key, 0, 1, Some(fits)).is_valid(0, &verifying));

        let too_long = Entry {
            value: 0,
            contact: CONTACT_11.into(),
            unit: Some("é".repeat(MAX_UNIT_BYTES / 2 + 1)),
            note: None,
        };
        assert!(!signed_slot(&key, 0, 1, Some(too_long)).is_valid(0, &verifying));
    }

    #[test]
    fn contact_field_must_be_64_lowercase_hex_chars() {
        let key = test_key();
        let verifying = key.verifying_key();

        for bad in [
            String::new(),
            "11".repeat(31),
            "11".repeat(33),
            "11".repeat(31) + "zz",
            "11".repeat(31) + "AA",
        ] {
            let entry = Entry {
                value: 0,
                contact: bad,
                unit: None,
                note: None,
            };
            assert!(
                !signed_slot(&key, 0, 1, Some(entry)).is_valid(0, &verifying),
                "malformed contact must be rejected"
            );
        }
    }

    #[test]
    fn contacts_bounds_are_inclusive() {
        let key = test_key();
        let verifying = key.verifying_key();

        let max_label = "l".repeat(MAX_CONTACT_LABEL_BYTES);
        let at_limit = signed_contacts(&key, 1, vec![contact(&max_label, &"11".repeat(32))]);
        assert!(at_limit.is_valid(&verifying));

        // 64 entries are allowed; the 65th is not.
        let entries: Vec<Contact> = (0..MAX_CONTACTS)
            .map(|index| {
                let mut user_id = [1u8; 32];
                user_id[31] = index as u8;
                contact(&format!("c{index}"), &hex::encode(user_id))
            })
            .collect();
        assert!(signed_contacts(&key, 1, entries.clone()).is_valid(&verifying));
        let mut too_many = entries;
        let mut user_id = [2u8; 32];
        user_id[31] = 200;
        too_many.push(contact("overflow", &hex::encode(user_id)));
        assert!(!signed_contacts(&key, 1, too_many).is_valid(&verifying));
    }

    #[test]
    fn contacts_fields_must_be_valid() {
        let key = test_key();
        let verifying = key.verifying_key();

        for entries in [
            vec![contact("", CONTACT_11)],
            vec![contact(
                &"l".repeat(MAX_CONTACT_LABEL_BYTES + 1),
                CONTACT_11,
            )],
            vec![contact("Alice", "")],
            vec![contact("Alice", &"11".repeat(31))],
            vec![contact("Alice", &"11".repeat(33))],
            vec![contact("Alice", &("11".repeat(31) + "AA"))],
        ] {
            assert!(
                !signed_contacts(&key, 1, entries).is_valid(&verifying),
                "invalid contact field must be rejected"
            );
        }
    }

    #[test]
    fn contacts_duplicate_user_id_and_label_rejected() {
        let key = test_key();
        let verifying = key.verifying_key();

        let duplicate_user = vec![contact("Alice", CONTACT_11), contact("Alicia", CONTACT_11)];
        assert!(!signed_contacts(&key, 1, duplicate_user).is_valid(&verifying));

        let duplicate_label = vec![contact("Alice", CONTACT_11), contact("Alice", CONTACT_22)];
        assert!(!signed_contacts(&key, 1, duplicate_label).is_valid(&verifying));
    }

    #[test]
    fn contacts_signature_tamper_fails() {
        let key = test_key();
        let verifying = key.verifying_key();
        let contacts = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        assert!(contacts.is_valid(&verifying));

        let mut changed_entry = contacts.clone();
        changed_entry.entries[0].label = "Mallory".into();
        assert!(!changed_entry.is_valid(&verifying));

        let mut changed_seq = contacts.clone();
        changed_seq.seq = 2;
        assert!(!changed_seq.is_valid(&verifying));

        let mut changed_sig = contacts;
        let mut sig = hex::decode(changed_sig.sig.as_ref().unwrap()).unwrap();
        sig[0] ^= 1;
        changed_sig.sig = Some(hex::encode(sig));
        assert!(!changed_sig.is_valid(&verifying));
    }

    // ---- parent ----------------------------------------------------------

    #[test]
    fn parent_seq_zero_requires_null_user_and_signature() {
        let key = test_key();
        let verifying = key.verifying_key();

        assert!(Parent::empty().is_valid(&verifying));

        let with_user = Parent {
            seq: 0,
            user_id: Some(CONTACT_11.into()),
            sig: None,
        };
        assert!(!with_user.is_valid(&verifying));

        let stray_signature = Parent {
            seq: 0,
            user_id: None,
            sig: Some(hex::encode([1u8; 64])),
        };
        assert!(!stray_signature.is_valid(&verifying));
    }

    #[test]
    fn parent_empty_record_at_positive_seq_is_a_tombstone() {
        let key = test_key();
        let cleared = signed_parent(&key, 3, None);
        assert!(cleared.is_valid(&key.verifying_key()));
        assert!(cleared.user_id.is_none());
    }

    #[test]
    fn parent_user_id_format_is_validated() {
        let key = test_key();
        let verifying = key.verifying_key();
        for bad in [
            String::new(),
            "11".repeat(31),
            "11".repeat(33),
            "11".repeat(31) + "zz",
            "11".repeat(31) + "AA",
        ] {
            let parent = Parent {
                seq: 1,
                user_id: Some(bad),
                sig: Some(hex::encode([1u8; 64])),
            };
            assert!(
                !parent.is_valid(&verifying),
                "malformed parent userId must be rejected"
            );
        }
    }

    #[test]
    fn parent_cannot_be_the_owner_itself() {
        let key = test_key();
        let owner = hex::encode(key.verifying_key().to_bytes());
        let own = signed_parent(&key, 1, Some(&owner));
        // The signature is genuine; only the self-parent rule rejects it.
        let signature = parse_signature(own.sig.as_deref().unwrap()).unwrap();
        key.verifying_key()
            .verify_strict(
                &parent_signing_bytes(own.seq, own.user_id.as_deref()),
                &signature,
            )
            .expect("the test fixture is correctly signed");
        assert!(!own.is_valid(&key.verifying_key()));
    }

    #[test]
    fn parent_tamper_fails() {
        let key = test_key();
        let verifying = key.verifying_key();
        let parent = signed_parent(&key, 3, Some(CONTACT_22));
        assert!(parent.is_valid(&verifying));

        let mut changed_seq = parent.clone();
        changed_seq.seq = 4;
        assert!(!changed_seq.is_valid(&verifying));

        let mut changed_user = parent.clone();
        changed_user.user_id = Some(CONTACT_11.into());
        assert!(!changed_user.is_valid(&verifying));

        let mut cleared = parent.clone();
        cleared.user_id = None;
        assert!(!cleared.is_valid(&verifying));

        let mut changed_sig = parent;
        let mut sig = hex::decode(changed_sig.sig.as_ref().unwrap()).unwrap();
        sig[0] ^= 1;
        changed_sig.sig = Some(hex::encode(sig));
        assert!(!changed_sig.is_valid(&verifying));
    }

    #[test]
    fn validate_state_rejects_a_self_parent() {
        let key = test_key();
        let owner = hex::encode(key.verifying_key().to_bytes());
        let mut state = populated_state(&key);
        state.parent = signed_parent(&key, 3, Some(&owner));
        assert!(state.validate(&key.verifying_key()).is_err());
        assert_eq!(
            NumberContract::validate_state(
                params(&key),
                State::from(state.to_bytes()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn parent_merge_uses_seq_then_signature_bytes() {
        let key = test_key();
        let alice = signed_parent(&key, 1, Some(CONTACT_11));
        let bob = signed_parent(&key, 1, Some(CONTACT_22));
        let expected = if parent_signature_bytes(&alice) >= parent_signature_bytes(&bob) {
            alice.clone()
        } else {
            bob.clone()
        };
        assert_eq!(merge_parent(&alice, &bob), expected);
        assert_eq!(merge_parent(&bob, &alice), expected);

        let newer = signed_parent(&key, 2, None);
        assert_eq!(merge_parent(&alice, &newer), newer);
        assert_eq!(merge_parent(&newer, &alice), newer);
    }

    #[test]
    fn update_state_merges_parent_from_full_state_and_delta() {
        let key = test_key();
        let base = populated_state(&key);

        let mut newer = base.clone();
        newer.parent = signed_parent(&key, 5, None);
        let updated = NumberContract::update_state(
            params(&key),
            State::from(base.to_bytes()),
            vec![UpdateData::State(State::from(newer.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(
            StateV3::decode(updated.as_ref()).unwrap().parent,
            newer.parent
        );

        // A delta carrying only the parent applies the same total order.
        let parent = signed_parent(&key, 6, Some(CONTACT_11));
        let delta = Delta {
            v: STATE_VERSION,
            parent: Some(parent.clone()),
            contacts: None,
            slots: vec![],
        };
        let updated = NumberContract::update_state(
            params(&key),
            State::from(base.to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(StateV3::decode(updated.as_ref()).unwrap().parent, parent);

        // Stale parent updates lose the merge without an error.
        let stale = Delta {
            v: STATE_VERSION,
            parent: Some(signed_parent(&key, 2, Some(CONTACT_22))),
            contacts: None,
            slots: vec![],
        };
        let updated = NumberContract::update_state(
            params(&key),
            State::from(base.to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(stale.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(
            StateV3::decode(updated.as_ref()).unwrap().parent,
            base.parent
        );
    }

    #[test]
    fn state_with_wrong_version_is_invalid() {
        let key = test_key();
        let mut state = populated_state(&key);
        assert!(state.validate(&key.verifying_key()).is_ok());
        state.v = 1;
        assert!(state.validate(&key.verifying_key()).is_err());
    }

    #[test]
    fn state_with_invalid_contacts_is_invalid() {
        let key = test_key();
        let mut state = populated_state(&key);
        state.contacts.entries[0].label = String::new();
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
        let json = r#"{"v":3,"parent":{"seq":0,"userId":null,"sig":null},"contacts":{"seq":0,"entries":[],"sig":null},"slots":[{"seq":0,"entry":null,"sig":null}]}"#;
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
        let empty = StateV3::empty();
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
        let mut invalid = StateV3::empty();
        // Slot 0 is valid, slot 1 is tampered; the whole update must fail and
        // must not half-apply slot 0.
        invalid.slots[0] = signed_slot(&key, 0, 1, Some(sample_entry()));
        let mut bad = signed_slot(&key, 1, 1, Some(sample_entry()));
        bad.entry.as_mut().unwrap().value = 999;
        invalid.slots[1] = bad;

        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV3::empty().to_bytes()),
            vec![UpdateData::State(State::from(invalid.to_bytes()))],
        );
        assert!(err.is_err());

        // Sanity: the original state is untouched and still validates.
        assert!(valid.validate(&key.verifying_key()).is_ok());
    }

    #[test]
    fn update_state_rejects_invalid_contacts_atomically() {
        let key = test_key();
        let mut invalid = StateV3::empty();
        invalid.slots[0] = signed_slot(&key, 0, 1, Some(sample_entry()));
        invalid.contacts = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        invalid.contacts.sig = Some(hex::encode([0u8; 64]));

        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV3::empty().to_bytes()),
            vec![UpdateData::State(State::from(invalid.to_bytes()))],
        );
        assert!(err.is_err());
    }

    #[test]
    fn update_state_rejects_invalid_delta_atomically() {
        let key = test_key();
        let first = signed_slot(&key, 0, 1, Some(sample_entry()));
        let mut second = signed_slot(&key, 1, 1, Some(sample_entry()));
        second.entry.as_mut().unwrap().value = 1234;
        let delta = Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: None,
            slots: vec![
                DeltaSlot::from_slot(0, &first),
                DeltaSlot::from_slot(1, &second),
            ],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV3::empty().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        );
        assert!(err.is_err());
    }

    #[test]
    fn update_state_rejects_invalid_delta_contacts_atomically() {
        let key = test_key();
        let mut contacts = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        contacts.entries[0].label = "Mallory".into();
        let delta = Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: Some(contacts),
            slots: vec![],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV3::empty().to_bytes()),
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
                contact: CONTACT_11.into(),
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

    // ---- merge laws -------------------------------------------------------

    #[test]
    fn contacts_merge_uses_seq_then_signature_bytes() {
        let key = test_key();
        let alice = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        let bob = signed_contacts(&key, 1, vec![contact("Bob", CONTACT_22)]);
        let expected = if contacts_signature_bytes(&alice) >= contacts_signature_bytes(&bob) {
            alice.clone()
        } else {
            bob.clone()
        };

        assert_eq!(merge_contacts(&alice, &bob), expected);
        assert_eq!(merge_contacts(&bob, &alice), expected);

        let newer = signed_contacts(&key, 2, vec![contact("Alice", CONTACT_11)]);
        assert_eq!(merge_contacts(&alice, &newer), newer);
        assert_eq!(merge_contacts(&newer, &alice), newer);
    }

    #[test]
    fn contacts_and_slots_merge_independently() {
        let key = test_key();
        let mut a = populated_state(&key);
        a.contacts = signed_contacts(&key, 5, vec![contact("Alice", CONTACT_11)]);
        let mut b = StateV3::empty();
        b.slots[2] = signed_slot(&key, 2, 4, Some(sample_entry()));
        b.contacts = signed_contacts(&key, 2, vec![contact("Bob", CONTACT_22)]);

        let result = merged(&a, &b);
        assert_eq!(result.contacts, a.contacts);
        assert_eq!(
            result.slots, a.slots,
            "lower-seq slots must not disturb the existing ones"
        );
    }

    // ---- summary and delta ------------------------------------------------

    fn summarize(state: &StateV3) -> StateSummary<'static> {
        NumberContract::summarize_state(
            Parameters::from(vec![0u8; 32]),
            State::from(state.to_bytes()),
        )
        .unwrap()
    }

    fn delta_from(state: &StateV3, summary: &StateSummary<'_>) -> StateDelta<'static> {
        NumberContract::get_state_delta(
            Parameters::from(vec![0u8; 32]),
            State::from(state.to_bytes()),
            StateSummary::from(summary.as_ref().to_vec()),
        )
        .unwrap()
    }

    #[test]
    fn initial_state_json_is_the_empty_board() {
        let initial: StateV3 = serde_json::from_str(include_str!("../initial_state.json")).unwrap();
        assert_eq!(initial, StateV3::empty());
    }

    #[test]
    fn wire_shapes_match_design() {
        let key = test_key();
        let state = populated_state(&key);

        let summary: serde_json::Value =
            serde_json::from_slice(&Summary::of(&state).to_bytes()).unwrap();
        assert_eq!(summary["v"], STATE_VERSION);
        assert_eq!(summary["parent"][0], 2);
        assert_eq!(summary["parent"][1].as_str().unwrap().len(), 32);
        assert_eq!(summary["contacts"][0], 1);
        assert_eq!(summary["contacts"][1].as_str().unwrap().len(), 32);
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

        let mut delta_state = StateV3::empty();
        delta_state.slots[2] = signed_slot(&key, 2, 4, Some(sample_entry()));
        delta_state.contacts = signed_contacts(&key, 3, vec![contact("Alice", CONTACT_11)]);
        let delta = Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: Some(delta_state.contacts.clone()),
            slots: vec![DeltaSlot::from_slot(2, &delta_state.slots[2])],
        };
        let decoded: serde_json::Value = serde_json::from_slice(&delta.to_bytes()).unwrap();
        assert_eq!(decoded["v"], STATE_VERSION);
        assert!(decoded["parent"].is_null());
        assert_eq!(decoded["contacts"]["seq"], 3);
        assert_eq!(decoded["contacts"]["entries"][0]["label"], "Alice");
        assert_eq!(decoded["contacts"]["entries"][0]["userId"], CONTACT_11);
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
        let from = StateV3::empty();
        let to = populated_state(&key);

        let delta = delta_from(&to, &summarize(&from));
        assert!(delta.size() > 0);
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert!(parsed.contacts.is_some(), "new subscriber needs contacts");

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
    fn contacts_only_delta_round_trips() {
        let key = test_key();
        let mut before = StateV3::empty();
        before.contacts = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        let mut after = before.clone();
        after.contacts = signed_contacts(
            &key,
            2,
            vec![contact("Alice", CONTACT_11), contact("Bob", CONTACT_22)],
        );

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.contacts.as_ref(), Some(&after.contacts));
        assert!(parsed.slots.is_empty());

        let synced = NumberContract::update_state(
            params(&key),
            State::from(before.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), after.to_bytes().as_slice());
    }

    #[test]
    fn summary_includes_parent_digest_and_zeros_when_empty() {
        let key = test_key();
        let empty = StateV3::empty();
        let summary = Summary::of(&empty);
        assert_eq!(summary.parent.0, 0);
        assert_eq!(summary.parent.1, "00000000000000000000000000000000");

        let mut state = empty;
        state.parent = signed_parent(&key, 1, Some(CONTACT_11));
        let summary = Summary::of(&state);
        assert_eq!(summary.parent.0, 1);
        assert_eq!(
            summary.parent.1,
            hex::encode(digest16(&parent_signing_bytes(1, Some(CONTACT_11))))
        );
        assert_eq!(summary.parent.1, "a3b70e503d1951bb363f6fbf310d4782");
    }

    #[test]
    fn parent_delta_round_trips_set_and_clear() {
        let key = test_key();
        let before = StateV3::empty();
        let mut after = before.clone();
        after.parent = signed_parent(&key, 1, Some(CONTACT_11));

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.parent.as_ref(), Some(&after.parent));
        assert!(parsed.contacts.is_none());
        assert!(parsed.slots.is_empty());

        let synced = NumberContract::update_state(
            params(&key),
            State::from(before.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), after.to_bytes().as_slice());

        // Clearing the parent is a tombstone at a higher seq.
        let mut cleared = after.clone();
        cleared.parent = signed_parent(&key, 2, None);
        let delta = delta_from(&cleared, &summarize(&after));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.parent.as_ref(), Some(&cleared.parent));
        let synced = NumberContract::update_state(
            params(&key),
            State::from(after.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), cleared.to_bytes().as_slice());
    }

    #[test]
    fn delta_omits_unchanged_parent() {
        let key = test_key();
        let before = populated_state(&key);
        let mut after = before.clone();
        after.slots[2] = signed_slot(&key, 2, 5, None);

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert!(parsed.parent.is_none());
        assert_eq!(parsed.slots.len(), 1);
    }

    #[test]
    fn get_state_delta_heals_equal_parent_seq_with_different_digest() {
        let key = test_key();
        let mut local = StateV3::empty();
        local.parent = signed_parent(&key, 3, Some(CONTACT_11));
        let mut remote = StateV3::empty();
        remote.parent = signed_parent(&key, 3, Some(CONTACT_22));

        let delta = delta_from(&local, &summarize(&remote));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.parent.as_ref(), Some(&local.parent));
    }

    #[test]
    fn empty_summary_includes_parent() {
        let key = test_key();
        let mut state = StateV3::empty();
        state.parent = signed_parent(&key, 1, Some(CONTACT_11));

        let delta = delta_from(&state, &StateSummary::from(vec![]));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.parent.as_ref(), Some(&state.parent));
    }

    #[test]
    fn get_state_delta_includes_contacts_when_local_is_newer() {
        let key = test_key();
        let mut before = populated_state(&key);
        before.contacts = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        let mut after = before.clone();
        after.contacts = signed_contacts(&key, 2, vec![contact("Bob", CONTACT_22)]);

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.contacts.as_ref(), Some(&after.contacts));
        assert!(
            parsed.slots.is_empty(),
            "unchanged slots must not be resent"
        );
    }

    #[test]
    fn get_state_delta_equals_seq_with_different_digest_heals() {
        let key = test_key();
        let mut local = StateV3::empty();
        local.contacts = signed_contacts(&key, 3, vec![contact("Alice", CONTACT_11)]);
        let mut remote_summary_state = StateV3::empty();
        // Same seq, different signed record (owner equivocation).
        remote_summary_state.contacts = signed_contacts(&key, 3, vec![contact("Bob", CONTACT_22)]);

        let delta = delta_from(&local, &summarize(&remote_summary_state));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.contacts.as_ref(), Some(&local.contacts));
    }

    #[test]
    fn delta_omits_unchanged_contacts() {
        let key = test_key();
        let before = populated_state(&key);
        let mut after = before.clone();
        after.slots[2] = signed_slot(&key, 2, 5, None);

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert!(parsed.contacts.is_none());
        assert_eq!(parsed.slots.len(), 1);
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

        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.contacts.as_ref(), Some(&state.contacts));

        let synced = NumberContract::update_state(
            params(&key),
            State::from(StateV3::empty().to_bytes()),
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
        assert_eq!(parsed.contacts.as_ref(), Some(&state.contacts));
        assert_eq!(
            parsed.slots.len(),
            state.slots.iter().filter(|s| s.seq > 0).count()
        );
    }

    #[test]
    fn tombstone_round_trips_through_delta() {
        let key = test_key();
        let mut before = StateV3::empty();
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
            contact: CONTACT_11.into(),
            unit: None,
            note: None,
        };
        let entry_b = Entry {
            value: 2,
            contact: CONTACT_22.into(),
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

        let state_a = state_with_slots(vec![
            slot_a,
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
            Slot::empty(),
        ]);
        let state_b = state_with_slots(vec![
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
            parent: None,
            contacts: None,
            slots: vec![DeltaSlot::from_slot(8, &slot)],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV3::empty().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        );
        assert!(err.is_err());
    }

    #[test]
    fn summary_decode_rejects_nonzero_digest_for_empty_record() {
        let zero_slots = serde_json::json!([
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"],
            [0, "00000000000000000000000000000000"]
        ]);

        for bad in [
            serde_json::json!({
                "v": 3,
                "parent": [0, "11111111111111111111111111111111"],
                "contacts": [0, "00000000000000000000000000000000"],
                "slots": zero_slots.clone(),
            }),
            serde_json::json!({
                "v": 3,
                "parent": [0, "00000000000000000000000000000000"],
                "contacts": [0, "11111111111111111111111111111111"],
                "slots": zero_slots,
            }),
        ] {
            assert!(Summary::decode(bad.to_string().as_bytes()).is_err());
        }
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

    fn arb_user_id() -> impl Strategy<Value = String> {
        proptest::array::uniform32(any::<u8>()).prop_map(hex::encode)
    }

    fn arb_entry() -> impl Strategy<Value = Entry> {
        (
            any::<i64>(),
            arb_user_id(),
            prop::option::of(arb_ascii(MAX_UNIT_BYTES)),
            prop::option::of(arb_ascii(100)),
        )
            .prop_map(|(value, contact, unit, note)| Entry {
                value,
                contact,
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

    /// Generate 0..=8 contacts with unique user ids and labels.
    fn arb_contacts_entries() -> impl Strategy<Value = Vec<Contact>> {
        proptest::collection::vec(proptest::array::uniform32(any::<u8>()), 0..=8).prop_map(|raws| {
            raws.into_iter()
                .enumerate()
                .map(|(index, mut user_id)| {
                    // Make user ids unique inside the record.
                    user_id[31] = index as u8;
                    contact(&format!("c{index}"), &hex::encode(user_id))
                })
                .collect()
        })
    }

    fn arb_contacts() -> impl Strategy<Value = Contacts> {
        (1u64..=100, arb_contacts_entries())
            .prop_map(|(seq, entries)| signed_contacts(&test_key(), seq, entries))
    }

    fn arb_parent() -> impl Strategy<Value = Parent> {
        (1u64..=100, prop::option::of(arb_user_id())).prop_map(|(seq, user_id)| {
            let key = test_key();
            let owner = hex::encode(key.verifying_key().to_bytes());
            // A self-parent is invalid; keep the generator inside the schema.
            let user_id = user_id.filter(|value| value != &owner);
            signed_parent(&key, seq, user_id.as_deref())
        })
    }

    fn arb_state() -> impl Strategy<Value = StateV3> {
        (
            arb_parent(),
            arb_contacts(),
            proptest::collection::vec(arb_slot_spec(), SLOT_COUNT),
        )
            .prop_map(|(parent, contacts, specs)| {
                let key = test_key();
                let slots = std::array::from_fn(|index| match &specs[index] {
                    SlotSpec::Empty => Slot::empty(),
                    SlotSpec::Tombstone(seq) => signed_slot(&key, index as u8, *seq, None),
                    SlotSpec::Value(seq, entry) => {
                        signed_slot(&key, index as u8, *seq, Some(entry.clone()))
                    }
                });
                StateV3 {
                    v: STATE_VERSION,
                    parent,
                    contacts,
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
            let empty = StateV3::empty();
            prop_assert_eq!(merged(&a, &empty).to_bytes(), a.to_bytes());
            prop_assert_eq!(merged(&empty, &a).to_bytes(), a.to_bytes());
        }

        #[test]
        fn merged_states_stay_valid(a in arb_state(), b in arb_state()) {
            let key = test_key();
            prop_assert!(merged(&a, &b).validate(&key.verifying_key()).is_ok());
        }

        #[test]
        fn contacts_merge_is_commutative_and_associative(
            a in arb_contacts(),
            b in arb_contacts(),
            c in arb_contacts(),
        ) {
            let ab = merge_contacts(&a, &b);
            let ba = merge_contacts(&b, &a);
            prop_assert_eq!(ab.clone(), ba);
            prop_assert_eq!(
                merge_contacts(&ab, &c),
                merge_contacts(&a, &merge_contacts(&b, &c))
            );
            prop_assert_eq!(merge_contacts(&a, &a), a);
        }

        #[test]
        fn parent_merge_is_commutative_and_associative(
            a in arb_parent(),
            b in arb_parent(),
            c in arb_parent(),
        ) {
            let ab = merge_parent(&a, &b);
            let ba = merge_parent(&b, &a);
            prop_assert_eq!(ab.clone(), ba);
            prop_assert_eq!(
                merge_parent(&ab, &c),
                merge_parent(&a, &merge_parent(&b, &c))
            );
            prop_assert_eq!(merge_parent(&a, &a), a);
        }

        #[test]
        fn parent_contacts_and_slot_merges_are_independent(a in arb_state(), b in arb_state()) {
            let result = merged(&a, &b);
            prop_assert_eq!(result.parent, merge_parent(&a.parent, &b.parent));
            prop_assert_eq!(result.contacts, merge_contacts(&a.contacts, &b.contacts));
            for index in 0..SLOT_COUNT {
                prop_assert_eq!(
                    result.slots[index].to_owned(),
                    merge_slot(&a.slots[index], &b.slots[index])
                );
            }
        }
    }
}
