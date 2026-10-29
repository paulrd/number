//! `number-contract` — one board per owner, with eight number slots, a signed
//! address book, at most one signed parent, at most one signed cooperative
//! payment and a signed issue/burn adjustment log.
//!
//! The contract is parameterised by the owner's raw 32-byte Ed25519 verifying
//! key. Every non-empty (`seq > 0`) slot, contacts record, parent record,
//! payments record and adjustments record carries an Ed25519 signature over the
//! canonical bytes defined in `DESIGN.md` §2, `DESIGN-payments.md` and
//! `DESIGN-v4.1-v5.md` "Pass 2". State is a fixed-size array of eight slots plus
//! one contacts record, one parent record, one payments record and one
//! adjustments record, so encoding is deterministic and the merge is a
//! component-wise maximum; there are no maps, caps or removals in state.
//!
//! The payments and adjustments records are evidence, not proof: the contract
//! checks their shape and signatures but deliberately does not check tree
//! topology, the LCA or the slot arithmetic. Those are UI protocol rules. The
//! adjustments log is a child-facing hint, not a tamper-proof audit trail: a
//! higher-seq record replaces the whole log.
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

/// Length of a payment id hex string (16 raw bytes).
pub const PAYMENT_ID_HEX_LEN: usize = 32;

/// Maximum number of legs on one payment. Only the LCA has two.
pub const MAX_PAYMENT_LEGS: usize = 2;

/// Maximum number of recently settled payment ids kept in one record.
pub const MAX_SETTLED_PAYMENTS: usize = 8;

/// Maximum number of digits in an octal address.
pub const MAX_ADDRESS_DIGITS: usize = 32;

/// Maximum route cursor value. A route has at most two 32-digit addresses.
pub const MAX_PAYMENT_CURSOR: u8 = 64;

/// Maximum number of entries in one adjustments log.
pub const MAX_ADJUSTMENTS: usize = 32;

/// Maximum length of an adjustment note in UTF-8 bytes.
pub const MAX_ADJUSTMENT_NOTE_BYTES: usize = 128;

/// State schema version written to (and required in) every wire object.
///
/// v5 adds the `adjustments` record. The client upgrades a v4 state by adding
/// `{"seq":0,"entries":[],"sig":null}` and setting `v:5`; slot, contacts,
/// parent, payments and v2/v3/v4 signing bytes are unchanged, so every existing
/// signature keeps validating.
pub const STATE_VERSION: u8 = 5;

/// Domain prefix of the canonical slot signing bytes. Unchanged from v2 so a v2
/// state's signatures keep validating after the client upgrades it to v5;
/// changing this is a breaking state change; see `DESIGN.md` §2.
pub const SIGNING_DOMAIN_SLOT: &[u8] = b"number:v2:slot";

/// Domain prefix of the canonical contacts signing bytes. Unchanged from v2.
pub const SIGNING_DOMAIN_CONTACTS: &[u8] = b"number:v2:contacts";

/// Domain prefix of the canonical parent signing bytes.
pub const SIGNING_DOMAIN_PARENT: &[u8] = b"number:v3:parent";

/// Domain prefix of the canonical payments signing bytes.
pub const SIGNING_DOMAIN_PAYMENTS: &[u8] = b"number:v4:payments";

/// Domain prefix of the canonical adjustments signing bytes (v5 only).
pub const SIGNING_DOMAIN_ADJUSTMENTS: &[u8] = b"number:v5:adjustments";

/// Whether `value` is exactly 64 lowercase hexadecimal characters (32 bytes).
pub fn validate_contact(value: &str) -> bool {
    value.len() == USER_ID_HEX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One applied leg of a cooperative payment. Every field is covered by the
/// payments signature.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentLeg {
    /// Slot index on the acting board, `0..=7`.
    pub slot: u8,
    /// Sequence of the slot write this leg performed.
    pub seq: u64,
    /// The signed post-leg slot value.
    #[serde(rename = "postValue")]
    pub post_value: i64,
    /// The slot signature written by that leg (128 lowercase hex chars).
    pub sig: String,
}

impl PaymentLeg {
    /// Whether the slot index, sequence and signature are within bounds.
    pub fn is_valid(&self) -> bool {
        usize::from(self.slot) < SLOT_COUNT && self.seq > 0 && is_lower_hex(&self.sig, 128)
    }
}

/// The active cooperative payment carried by one board. The contract checks
/// only shape and signature; route and arithmetic rules live in the UI.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    /// `blake3(src || srcSeq || dst || amount)[0..16]`, 32 lowercase hex chars.
    pub id: String,
    /// Source owner id (64 lowercase hex chars).
    pub src: String,
    /// Destination owner id (64 lowercase hex chars).
    pub dst: String,
    /// Positive amount in hundredths.
    pub amount: i64,
    /// Zero-based octal route address of the source; root is `""`.
    #[serde(rename = "srcAddr")]
    pub src_addr: String,
    /// Zero-based octal route address of the destination; root is `""`.
    #[serde(rename = "dstAddr")]
    pub dst_addr: String,
    /// Number of route hops already applied.
    pub cursor: u8,
    /// `forward` | `reverse` | `terminal`.
    pub phase: String,
    /// One of the eight statuses listed in `DESIGN-payments.md`.
    pub status: String,
    /// Owner expected to act next; all-zero when terminal.
    pub next: String,
    /// Optional failure reason.
    #[serde(default)]
    pub fail: Option<String>,
    /// Applied legs, at most [`MAX_PAYMENT_LEGS`].
    pub legs: Vec<PaymentLeg>,
}

impl Payment {
    /// Whether every field is within the schema bounds and the phase/status
    /// combination is coherent.
    ///
    /// This is deliberately structural. It does not check tree topology, the
    /// LCA, address route lengths or the slot arithmetic.
    pub fn is_valid(&self) -> bool {
        if !is_lower_hex(&self.id, PAYMENT_ID_HEX_LEN)
            || !validate_contact(&self.src)
            || !validate_contact(&self.dst)
            || !validate_contact(&self.next)
            || self.amount <= 0
            || !validate_address(&self.src_addr)
            || !validate_address(&self.dst_addr)
            || self.cursor > MAX_PAYMENT_CURSOR
            || phase_tag(&self.phase).is_none()
            || status_tag(&self.status).is_none()
            || fail_tag(self.fail.as_deref()).is_none()
            || self.legs.len() > MAX_PAYMENT_LEGS
            || self.legs.iter().enumerate().any(|(index, leg)| {
                !leg.is_valid()
                    || self.legs[..index]
                        .iter()
                        .any(|other| other.slot == leg.slot)
            })
        {
            return false;
        }

        // A terminal payment must not point at another actor.
        if self.phase == "terminal" && !self.next.bytes().all(|byte| byte == b'0') {
            return false;
        }

        // Conservative phase/status coherence. Transitional combinations the
        // protocol needs (`acted` while forward or reverse, `aborted` during a
        // reverse walk, `superseded` anywhere) are allowed.
        match self.status.as_str() {
            "offered" => self.cursor == 0 && self.legs.is_empty(),
            "complete" | "reversed" | "blocked" => self.phase == "terminal",
            _ => true,
        }
    }
}

/// The signed payments record. `seq == 0` is the empty record (no settled ids,
/// no entry, no signature); `seq > 0` with `entry == None` is a legal tombstone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Payments {
    pub seq: u64,
    /// Recently settled payment ids, oldest first. Bounded by
    /// [`MAX_SETTLED_PAYMENTS`]; each id is 32 lowercase hex characters.
    #[serde(default)]
    pub settled: Vec<String>,
    pub entry: Option<Payment>,
    pub sig: Option<String>,
}

impl Payments {
    /// The initial, empty payments record.
    pub fn empty() -> Self {
        Self {
            seq: 0,
            settled: Vec::new(),
            entry: None,
            sig: None,
        }
    }

    /// Whether this record is valid under the owner `key`.
    ///
    /// Covers the seq-0 invariant, the settled-id bounds and uniqueness, the
    /// payment field bounds, the tombstone shape and the Ed25519 signature over
    /// the canonical bytes.
    pub fn is_valid(&self, key: &VerifyingKey) -> bool {
        if self.seq == 0 {
            return self.settled.is_empty() && self.entry.is_none() && self.sig.is_none();
        }
        if self.settled.len() > MAX_SETTLED_PAYMENTS {
            return false;
        }
        for (index, id) in self.settled.iter().enumerate() {
            if !is_lower_hex(id, PAYMENT_ID_HEX_LEN)
                || self.settled[..index].iter().any(|other| other == id)
            {
                return false;
            }
        }
        if self.entry.as_ref().is_some_and(|entry| !entry.is_valid()) {
            return false;
        }
        let Some(signature) = self.sig.as_deref().and_then(parse_signature) else {
            return false;
        };
        let bytes = payments_signing_bytes(self.seq, &self.settled, self.entry.as_ref());
        key.verify_strict(&bytes, &signature).is_ok()
    }
}

/// One issue/burn adjustment to a slot's liability. Every field is covered by
/// the adjustments signature. The log is a child-facing hint, not a
/// tamper-proof audit trail.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Adjustment {
    /// Slot index on this board, `0..=7`.
    pub slot: u8,
    /// The slot write this adjustment describes (`slot.seq`), always `> 0`.
    #[serde(rename = "slotSeq")]
    pub slot_seq: u64,
    /// Positive issues, negative burns; never zero.
    pub delta: i64,
    /// The signed post-adjustment slot value; never negative.
    #[serde(rename = "postValue")]
    pub post_value: i64,
    /// Optional short reason, at most [`MAX_ADJUSTMENT_NOTE_BYTES`] UTF-8 bytes.
    #[serde(default)]
    pub note: Option<String>,
}

impl Adjustment {
    /// Whether every field is within the schema bounds and the implied
    /// pre-value is non-negative and non-overflowing.
    pub fn is_valid(&self) -> bool {
        if usize::from(self.slot) >= SLOT_COUNT
            || self.slot_seq == 0
            || self.delta == 0
            || self.post_value < 0
        {
            return false;
        }
        if self
            .note
            .as_deref()
            .is_some_and(|note| note.len() > MAX_ADJUSTMENT_NOTE_BYTES)
        {
            return false;
        }
        let pre_value = if self.delta > 0 {
            self.post_value.checked_sub(self.delta)
        } else {
            self.delta
                .checked_neg()
                .and_then(|magnitude| self.post_value.checked_add(magnitude))
        };
        pre_value.is_some_and(|pre| pre >= 0)
    }
}

/// The signed issue/burn adjustment log. `seq == 0` is the empty record (no
/// entries, no signature); `seq > 0` replaces the whole log.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Adjustments {
    pub seq: u64,
    /// Entries oldest first. Per slot, `slot_seq` strictly increases in list
    /// order; at most [`MAX_ADJUSTMENTS`] entries.
    pub entries: Vec<Adjustment>,
    pub sig: Option<String>,
}

impl Adjustments {
    /// The initial, empty adjustment log.
    pub fn empty() -> Self {
        Self {
            seq: 0,
            entries: Vec::new(),
            sig: None,
        }
    }

    /// Whether this record is valid under the owner `key`.
    ///
    /// Covers the seq-0 invariant, the entry count and field bounds, duplicate
    /// `(slot, slot_seq)` rejection, per-slot increasing `slot_seq` in list
    /// order and the Ed25519 signature over the canonical bytes.
    pub fn is_valid(&self, key: &VerifyingKey) -> bool {
        if self.seq == 0 {
            return self.entries.is_empty() && self.sig.is_none();
        }
        if self.entries.len() > MAX_ADJUSTMENTS {
            return false;
        }
        for (index, entry) in self.entries.iter().enumerate() {
            if !entry.is_valid() {
                return false;
            }
            // Covers both duplicates and a decreasing slot_seq within a slot.
            if self.entries[..index]
                .iter()
                .any(|other| other.slot == entry.slot && other.slot_seq >= entry.slot_seq)
            {
                return false;
            }
        }
        let Some(signature) = self.sig.as_deref().and_then(parse_signature) else {
            return false;
        };
        let bytes = adjustments_signing_bytes(self.seq, &self.entries);
        key.verify_strict(&bytes, &signature).is_ok()
    }
}

/// Whether `value` is an octal address: at most [`MAX_ADDRESS_DIGITS`] digits,
/// each `0..=7`. The root address is the empty string.
pub fn validate_address(value: &str) -> bool {
    value.len() <= MAX_ADDRESS_DIGITS && value.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn phase_tag(value: &str) -> Option<u8> {
    match value {
        "forward" => Some(0),
        "reverse" => Some(1),
        "terminal" => Some(2),
        _ => None,
    }
}

fn status_tag(value: &str) -> Option<u8> {
    match value {
        "offered" => Some(0),
        "acted" => Some(1),
        "complete" => Some(2),
        "reversing" => Some(3),
        "reversed" => Some(4),
        "aborted" => Some(5),
        "blocked" => Some(6),
        "superseded" => Some(7),
        _ => None,
    }
}

fn fail_tag(value: Option<&str>) -> Option<u8> {
    match value {
        None => Some(0),
        Some("negative") => Some(1),
        Some("no-destination") => Some(2),
        Some("busy") => Some(3),
        Some("refused") => Some(4),
        Some("address-mismatch") => Some(5),
        Some("blocked") => Some(6),
        Some("superseded") => Some(7),
        Some(_) => None,
    }
}

/// Decode a payment id (32 hex chars) into its raw 16 bytes. Invalid input maps
/// to all-zero bytes; callers validate before signing or verifying.
fn payment_id_raw(value: &str) -> [u8; 16] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 16])
}

/// Decode a 128-hex-character signature into raw bytes. Invalid input maps to
/// all-zero bytes; callers validate before signing or verifying.
fn signature_raw(value: &str) -> [u8; 64] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 64])
}

/// Canonical payments signing bytes, hand-built exactly as specified in
/// `DESIGN-payments.md`.
///
/// ```text
/// b"number:v4:payments"
/// || seq: u64 little-endian
/// || settled_count: u8
/// || for each settled id: 16 raw bytes
/// || tag: u8                       // 0 = no entry, 1 = entry
/// // only when tag == 1:
/// || id: 16 raw bytes
/// || src: 32 raw bytes
/// || dst: 32 raw bytes
/// || amount: i64 little-endian
/// || srcAddr_len: u32 LE || srcAddr ASCII bytes
/// || dstAddr_len: u32 LE || dstAddr ASCII bytes
/// || cursor: u8
/// || phase_tag: u8
/// || status_tag: u8
/// || fail_tag: u8
/// || next: 32 raw bytes
/// || legs_count: u8
/// || for each leg:
///      slot: u8 || seq: u64 LE || postValue: i64 LE || sig: 64 raw bytes
/// ```
///
/// A tombstone at `seq > 0` signs `tag = 0`; `seq == 0` is never signed.
/// Unknown enum strings encode as tag 0; callers validate first.
pub fn payments_signing_bytes(seq: u64, settled: &[String], entry: Option<&Payment>) -> Vec<u8> {
    let mut out = Vec::with_capacity(256 + settled.len() * 16);
    out.extend_from_slice(SIGNING_DOMAIN_PAYMENTS);
    out.extend_from_slice(&seq.to_le_bytes());
    let settled_count =
        u8::try_from(settled.len()).expect("settled count is bounded by MAX_SETTLED_PAYMENTS");
    out.push(settled_count);
    for id in settled {
        out.extend_from_slice(&payment_id_raw(id));
    }
    match entry {
        None => out.push(0),
        Some(payment) => {
            out.push(1);
            out.extend_from_slice(&payment_id_raw(&payment.id));
            out.extend_from_slice(&contact_raw(&payment.src));
            out.extend_from_slice(&contact_raw(&payment.dst));
            out.extend_from_slice(&payment.amount.to_le_bytes());
            push_optional_string(&mut out, Some(&payment.src_addr));
            push_optional_string(&mut out, Some(&payment.dst_addr));
            out.push(payment.cursor);
            out.push(phase_tag(&payment.phase).unwrap_or(0));
            out.push(status_tag(&payment.status).unwrap_or(0));
            out.push(fail_tag(payment.fail.as_deref()).unwrap_or(0));
            out.extend_from_slice(&contact_raw(&payment.next));
            let leg_count =
                u8::try_from(payment.legs.len()).expect("leg count is bounded by MAX_PAYMENT_LEGS");
            out.push(leg_count);
            for leg in &payment.legs {
                out.push(leg.slot);
                out.extend_from_slice(&leg.seq.to_le_bytes());
                out.extend_from_slice(&leg.post_value.to_le_bytes());
                out.extend_from_slice(&signature_raw(&leg.sig));
            }
        }
    }
    out
}

/// Canonical adjustments signing bytes, hand-built exactly as specified in
/// `DESIGN-v4.1-v5.md` "Pass 2".
///
/// ```text
/// b"number:v5:adjustments"
/// || seq: u64 little-endian
/// || count: u32 LE
/// || for each entry, in order:
///      slot: u8
///      || slot_seq: u64 LE
///      || delta: i64 LE
///      || post_value: i64 LE
///      || note_len: u32 LE || note bytes
/// ```
///
/// `None` notes encode as length 0. `seq == 0` is never signed.
pub fn adjustments_signing_bytes(seq: u64, entries: &[Adjustment]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + entries.len() * 40);
    out.extend_from_slice(SIGNING_DOMAIN_ADJUSTMENTS);
    out.extend_from_slice(&seq.to_le_bytes());
    let count =
        u32::try_from(entries.len()).expect("adjustment count is bounded by MAX_ADJUSTMENTS");
    out.extend_from_slice(&count.to_le_bytes());
    for entry in entries {
        out.push(entry.slot);
        out.extend_from_slice(&entry.slot_seq.to_le_bytes());
        out.extend_from_slice(&entry.delta.to_le_bytes());
        out.extend_from_slice(&entry.post_value.to_le_bytes());
        let note = entry.note.as_deref().unwrap_or_default().as_bytes();
        let note_len = u32::try_from(note.len()).expect("note bounds keep lengths below u32::MAX");
        out.extend_from_slice(&note_len.to_le_bytes());
        out.extend_from_slice(note);
    }
    out
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

/// Full contract state v5 (§2 plus `DESIGN-payments.md` and the Pass 2
/// adjustment log).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StateV5 {
    pub v: u8,
    pub parent: Parent,
    pub contacts: Contacts,
    pub payments: Payments,
    pub adjustments: Adjustments,
    pub slots: [Slot; SLOT_COUNT],
}

impl StateV5 {
    /// An all-empty board.
    pub fn empty() -> Self {
        Self {
            v: STATE_VERSION,
            parent: Parent::empty(),
            contacts: Contacts::empty(),
            payments: Payments::empty(),
            adjustments: Adjustments::empty(),
            slots: std::array::from_fn(|_| Slot::empty()),
        }
    }

    /// Decode JSON state bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, ContractError> {
        serde_json::from_slice(bytes).map_err(|_| ContractError::InvalidState)
    }

    /// Encode state deterministically as JSON.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("StateV5 serialization cannot fail")
    }

    /// Validate version, parent, contacts, payments, adjustments, slot count
    /// (enforced by the array type), the seq-0 invariants, field bounds and
    /// every signature under `key`.
    ///
    /// Merge-invariant only: adjustments are never compared with `slots` here.
    /// The two records merge independently, so a merged state may legitimately
    /// carry an adjustment whose referenced slot write was superseded.
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
        if !self.payments.is_valid(key) {
            return Err(ContractError::InvalidState);
        }
        if !self.adjustments.is_valid(key) {
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
        self.payments = merge_payments(&self.payments, &other.payments);
        self.adjustments = merge_adjustments(&self.adjustments, &other.adjustments);
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

/// Payments merge: higher `seq` wins; on equal `seq` the lexicographically
/// greater signature bytes win. A higher-seq tombstone clears the payment.
fn merge_payments(a: &Payments, b: &Payments) -> Payments {
    if a.seq > b.seq {
        return a.clone();
    }
    if b.seq > a.seq {
        return b.clone();
    }
    if payments_signature_bytes(a) >= payments_signature_bytes(b) {
        a.clone()
    } else {
        b.clone()
    }
}

/// Adjustments merge: higher `seq` wins; on equal `seq` the lexicographically
/// greater signature bytes win. A higher-seq record replaces the whole log.
fn merge_adjustments(a: &Adjustments, b: &Adjustments) -> Adjustments {
    if a.seq > b.seq {
        return a.clone();
    }
    if b.seq > a.seq {
        return b.clone();
    }
    if adjustments_signature_bytes(a) >= adjustments_signature_bytes(b) {
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

/// The payments signature field as bytes. An empty record (and any malformed
/// sig, which the validators reject before merging) compares as all-zero bytes.
fn payments_signature_bytes(payments: &Payments) -> [u8; 64] {
    payments
        .sig
        .as_deref()
        .and_then(|sig| {
            let bytes = hex::decode(sig).ok()?;
            bytes.try_into().ok()
        })
        .unwrap_or([0; 64])
}

/// The adjustments signature field as bytes. An empty record (and any malformed
/// sig, which the validators reject before merging) compares as all-zero bytes.
fn adjustments_signature_bytes(adjustments: &Adjustments) -> [u8; 64] {
    adjustments
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

/// State summary (§2.6). One parent pair, one contacts pair, one payments pair,
/// one adjustments pair plus exactly eight slot pairs; the digest is all-zero
/// for an empty record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub v: u8,
    pub parent: SlotSummary,
    pub contacts: SlotSummary,
    pub payments: SlotSummary,
    pub adjustments: SlotSummary,
    pub slots: [SlotSummary; SLOT_COUNT],
}

impl Summary {
    /// Build the summary for `state`.
    pub fn of(state: &StateV5) -> Self {
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
        let payments = if state.payments.seq == 0 {
            SlotSummary(0, hex::encode([0u8; 16]))
        } else {
            let digest = digest16(&payments_signing_bytes(
                state.payments.seq,
                &state.payments.settled,
                state.payments.entry.as_ref(),
            ));
            SlotSummary(state.payments.seq, hex::encode(digest))
        };
        let adjustments = if state.adjustments.seq == 0 {
            SlotSummary(0, hex::encode([0u8; 16]))
        } else {
            let digest = digest16(&adjustments_signing_bytes(
                state.adjustments.seq,
                &state.adjustments.entries,
            ));
            SlotSummary(state.adjustments.seq, hex::encode(digest))
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
            payments,
            adjustments,
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
        let payments_digest = summary_digest(&summary.payments.1)?;
        if summary.payments.0 == 0 && payments_digest != [0u8; 16] {
            return Err(ContractError::InvalidDelta);
        }
        let adjustments_digest = summary_digest(&summary.adjustments.1)?;
        if summary.adjustments.0 == 0 && adjustments_digest != [0u8; 16] {
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

/// Validated delta payload: the optional parent, contacts, payments and
/// adjustments records plus changed slots.
type ValidatedDelta = (
    Option<Parent>,
    Option<Contacts>,
    Option<Payments>,
    Option<Adjustments>,
    Vec<(u8, Slot)>,
);

/// State delta (§2.7, v5).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Delta {
    pub v: u8,
    /// `null`/absent when the parent record is unchanged.
    #[serde(default)]
    pub parent: Option<Parent>,
    /// `null`/absent when the contacts record is unchanged.
    #[serde(default)]
    pub contacts: Option<Contacts>,
    /// `null`/absent when the payments record is unchanged.
    #[serde(default)]
    pub payments: Option<Payments>,
    /// `null`/absent when the adjustments record is unchanged.
    #[serde(default)]
    pub adjustments: Option<Adjustments>,
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

    /// Validate the parent, contacts, payments and adjustments records and
    /// every slot under `key`, returning them for merging. Validation is
    /// all-or-nothing before anything is applied.
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
        let payments = match &self.payments {
            None => None,
            Some(payments) => {
                if !payments.is_valid(key) {
                    return Err(ContractError::InvalidDelta);
                }
                Some(payments.clone())
            }
        };
        let adjustments = match &self.adjustments {
            None => None,
            Some(adjustments) => {
                if !adjustments.is_valid(key) {
                    return Err(ContractError::InvalidDelta);
                }
                Some(adjustments.clone())
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
        Ok((parent, contacts, payments, adjustments, slots))
    }
}

/// Merge-time provenance for one incoming delta.
///
/// Every adjustment entry that is not already in the current log must describe
/// a slot write carried by the same delta: the slot sequence must match, the
/// written value must equal `post_value`, and `post_value` must equal the
/// pre-update slot value (0 for an empty slot) plus `delta`. This is not part of
/// `validate`, because adjustments and slots merge independently.
fn adjustments_provenance_holds(
    current: &StateV5,
    adjustments: &Adjustments,
    slots: &[(u8, Slot)],
) -> bool {
    for entry in &adjustments.entries {
        if current.adjustments.entries.contains(entry) {
            continue;
        }
        let Some((_, slot)) = slots.iter().find(|(index, _)| *index == entry.slot) else {
            return false;
        };
        if slot.seq != entry.slot_seq {
            return false;
        }
        let Some(slot_entry) = slot.entry.as_ref() else {
            return false;
        };
        if slot_entry.value != entry.post_value {
            return false;
        }
        let old_value = current.slots[usize::from(entry.slot)]
            .entry
            .as_ref()
            .map_or(0, |entry| entry.value);
        if old_value.checked_add(entry.delta) != Some(entry.post_value) {
            return false;
        }
    }
    true
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
    Full(Box<StateV5>),
    Delta {
        parent: Option<Parent>,
        contacts: Option<Contacts>,
        payments: Option<Box<Payments>>,
        adjustments: Option<Box<Adjustments>>,
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
        let Ok(state) = StateV5::decode(state.as_ref()) else {
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
        let mut current = StateV5::decode(state.as_ref())?;
        current.validate(&key)?;

        // Stage and validate everything before mutating. A single invalid
        // contact or slot rejects the whole update (single writer, so atomicity
        // is correct).
        let mut staged = Vec::with_capacity(data.len());
        for item in &data {
            match item {
                UpdateData::State(incoming) => {
                    let incoming = StateV5::decode(incoming.as_ref())?;
                    incoming.validate(&key)?;
                    staged.push(Incoming::Full(Box::new(incoming)));
                }
                UpdateData::Delta(delta) => {
                    let delta = Delta::decode(delta.as_ref())?;
                    let (parent, contacts, payments, adjustments, slots) = delta.validated(&key)?;
                    staged.push(Incoming::Delta {
                        parent,
                        contacts,
                        payments: payments.map(Box::new),
                        adjustments: adjustments.map(Box::new),
                        slots,
                    });
                }
                UpdateData::StateAndDelta {
                    state: incoming,
                    delta,
                } => {
                    let incoming = StateV5::decode(incoming.as_ref())?;
                    incoming.validate(&key)?;
                    let delta = Delta::decode(delta.as_ref())?;
                    let (parent, contacts, payments, adjustments, slots) = delta.validated(&key)?;
                    staged.push(Incoming::Full(Box::new(incoming)));
                    staged.push(Incoming::Delta {
                        parent,
                        contacts,
                        payments: payments.map(Box::new),
                        adjustments: adjustments.map(Box::new),
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
                    payments,
                    adjustments,
                    slots,
                } => {
                    // Provenance is a per-delta, merge-time rule. A full-state
                    // update is the migration path and only validates
                    // signatures/bounds. Entries already present in the current
                    // log are history and need no slot write in this delta.
                    if let Some(adjustments) = &adjustments {
                        if !adjustments_provenance_holds(&current, adjustments, &slots) {
                            return Err(ContractError::InvalidDelta);
                        }
                    }
                    if let Some(parent) = parent {
                        current.parent = merge_parent(&current.parent, &parent);
                    }
                    if let Some(contacts) = contacts {
                        current.contacts = merge_contacts(&current.contacts, &contacts);
                    }
                    if let Some(payments) = payments {
                        current.payments = merge_payments(&current.payments, &payments);
                    }
                    if let Some(adjustments) = adjustments {
                        current.adjustments = merge_adjustments(&current.adjustments, &adjustments);
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
        let state = StateV5::decode(state.as_ref())?;
        Ok(StateSummary::from(Summary::of(&state).to_bytes()))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = StateV5::decode(state.as_ref())?;
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

        let local_payments_digest = if state.payments.seq == 0 {
            [0u8; 16]
        } else {
            digest16(&payments_signing_bytes(
                state.payments.seq,
                &state.payments.settled,
                state.payments.entry.as_ref(),
            ))
        };
        let include_payments = match &summary {
            None => state.payments.seq > 0,
            Some(summary) => {
                let remote_digest = summary_digest(&summary.payments.1)?;
                state.payments.seq > summary.payments.0
                    || (state.payments.seq == summary.payments.0
                        && local_payments_digest != remote_digest)
            }
        };

        let local_adjustments_digest = if state.adjustments.seq == 0 {
            [0u8; 16]
        } else {
            digest16(&adjustments_signing_bytes(
                state.adjustments.seq,
                &state.adjustments.entries,
            ))
        };
        let include_adjustments = match &summary {
            None => state.adjustments.seq > 0,
            Some(summary) => {
                let remote_digest = summary_digest(&summary.adjustments.1)?;
                state.adjustments.seq > summary.adjustments.0
                    || (state.adjustments.seq == summary.adjustments.0
                        && local_adjustments_digest != remote_digest)
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

        if !include_parent
            && !include_contacts
            && !include_payments
            && !include_adjustments
            && slots.is_empty()
        {
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
            payments: if include_payments {
                Some(state.payments.clone())
            } else {
                None
            },
            adjustments: if include_adjustments {
                Some(state.adjustments.clone())
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
    const CONTACT_33: &str = "3333333333333333333333333333333333333333333333333333333333333333";
    const ZERO_USER_ID: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    const PAYMENT_ID: &str = "0123456789abcdef0123456789abcdef";

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

    fn signed_payments(key: &SigningKey, seq: u64, entry: Option<Payment>) -> Payments {
        signed_payments_with_settled(key, seq, Vec::new(), entry)
    }

    fn signed_payments_with_settled(
        key: &SigningKey,
        seq: u64,
        settled: Vec<String>,
        entry: Option<Payment>,
    ) -> Payments {
        let signature = key.sign(&payments_signing_bytes(seq, &settled, entry.as_ref()));
        Payments {
            seq,
            settled,
            entry,
            sig: Some(hex::encode(signature.to_bytes())),
        }
    }

    fn payment_id(tag: u8) -> String {
        hex::encode([tag; 16])
    }

    fn signed_adjustments(key: &SigningKey, seq: u64, entries: Vec<Adjustment>) -> Adjustments {
        let signature = key.sign(&adjustments_signing_bytes(seq, &entries));
        Adjustments {
            seq,
            entries,
            sig: Some(hex::encode(signature.to_bytes())),
        }
    }

    fn sample_leg(slot: u8, seq: u64, post_value: i64) -> PaymentLeg {
        PaymentLeg {
            slot,
            seq,
            post_value,
            sig: "5a".repeat(64),
        }
    }

    fn sample_payment() -> Payment {
        Payment {
            id: PAYMENT_ID.into(),
            src: CONTACT_11.into(),
            dst: CONTACT_22.into(),
            amount: 1250,
            src_addr: "52".into(),
            dst_addr: "31".into(),
            cursor: 2,
            phase: "forward".into(),
            status: "acted".into(),
            next: CONTACT_33.into(),
            fail: None,
            legs: vec![sample_leg(1, 4, 3750)],
        }
    }

    fn terminal_payment() -> Payment {
        Payment {
            id: PAYMENT_ID.into(),
            src: CONTACT_11.into(),
            dst: CONTACT_22.into(),
            amount: 1250,
            src_addr: "52".into(),
            dst_addr: "31".into(),
            cursor: 5,
            phase: "terminal".into(),
            status: "complete".into(),
            next: ZERO_USER_ID.into(),
            fail: None,
            legs: vec![sample_leg(1, 4, 3750), sample_leg(3, 5, -1250)],
        }
    }

    fn signed_tombstone(key: &SigningKey, seq: u64) -> Payments {
        signed_payments(key, seq, None)
    }

    fn params(key: &SigningKey) -> Parameters<'static> {
        Parameters::from(key.verifying_key().to_bytes().to_vec())
    }

    fn state_of(slots: Vec<Slot>, contacts: Contacts) -> StateV5 {
        let slots: [Slot; SLOT_COUNT] = slots
            .try_into()
            .expect("test helper always supplies eight slots");
        StateV5 {
            v: STATE_VERSION,
            parent: Parent::empty(),
            contacts,
            payments: Payments::empty(),
            adjustments: Adjustments::empty(),
            slots,
        }
    }

    fn state_with_slots(slots: Vec<Slot>) -> StateV5 {
        state_of(slots, Contacts::empty())
    }

    fn merged(a: &StateV5, b: &StateV5) -> StateV5 {
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

    fn populated_state(key: &SigningKey) -> StateV5 {
        let mut state = StateV5::empty();
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

    #[test]
    fn golden_payments_signing_bytes_are_pinned() {
        let payment = sample_payment();
        let bytes = payments_signing_bytes(6, &[], Some(&payment));
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76343a7061796d656e7473060000000000000000010123456789abcdef0123456789abcdef11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222e20400000000000002000000353202000000333102000100333333333333333333333333333333333333333333333333333333333333333301010400000000000000a60e0000000000005a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "325c8d0a9c2b51ce5f2069e724b39ad3"
        );

        let two_leg = terminal_payment();
        let bytes = payments_signing_bytes(7, &[], Some(&two_leg));
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76343a7061796d656e7473070000000000000000010123456789abcdef0123456789abcdef11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222e20400000000000002000000353202000000333105020200000000000000000000000000000000000000000000000000000000000000000002010400000000000000a60e0000000000005a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0305000000000000001efbffffffffffff5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "9b1419ef01132905668a238ad95e3456"
        );

        // A non-empty settled list is covered before the entry tag.
        let settled = vec![payment_id(0xaa), payment_id(0xbb)];
        let bytes = payments_signing_bytes(9, &settled, Some(&payment));
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76343a7061796d656e7473090000000000000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb010123456789abcdef0123456789abcdef11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222e20400000000000002000000353202000000333102000100333333333333333333333333333333333333333333333333333333333333333301010400000000000000a60e0000000000005a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "9c92f94d2c39c9ad770814d93488de0e"
        );

        // A tombstone at seq > 0 signs tag 0 (settled count 0).
        let tombstone = payments_signing_bytes(8, &[], None);
        assert_eq!(
            hex::encode(&tombstone),
            "6e756d6265723a76343a7061796d656e747308000000000000000000"
        );
        assert_eq!(
            hex::encode(digest16(&tombstone)),
            "841f50504a053591eae8ebe1c51035c1"
        );
    }

    /// Migration safety: the client upgrades a v2 state to v5 by adding an empty
    /// parent, an empty payments record and an empty adjustments record. The v2
    /// slot/contacts signing domains are unchanged, so the old signatures must
    /// still validate under a v5 contract.
    #[test]
    fn v2_signed_slots_and_contacts_validate_with_empty_v5_records() {
        let key = test_key();
        let verifying = key.verifying_key();
        let mut state = StateV5::empty();
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

        assert_eq!(state.v, 5);
        assert_eq!(state.parent, Parent::empty());
        assert_eq!(state.payments, Payments::empty());
        assert_eq!(state.adjustments, Adjustments::empty());
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
            StateV5::decode(updated.as_ref()).unwrap().parent,
            newer.parent
        );

        // A delta carrying only the parent applies the same total order.
        let parent = signed_parent(&key, 6, Some(CONTACT_11));
        let delta = Delta {
            v: STATE_VERSION,
            parent: Some(parent.clone()),
            contacts: None,
            payments: None,
            adjustments: None,
            slots: vec![],
        };
        let updated = NumberContract::update_state(
            params(&key),
            State::from(base.to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(StateV5::decode(updated.as_ref()).unwrap().parent, parent);

        // Stale parent updates lose the merge without an error.
        let stale = Delta {
            v: STATE_VERSION,
            parent: Some(signed_parent(&key, 2, Some(CONTACT_22))),
            contacts: None,
            payments: None,
            adjustments: None,
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
            StateV5::decode(updated.as_ref()).unwrap().parent,
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
        let json = r#"{"v":4,"parent":{"seq":0,"userId":null,"sig":null},"contacts":{"seq":0,"entries":[],"sig":null},"payments":{"seq":0,"entry":null,"sig":null},"slots":[{"seq":0,"entry":null,"sig":null}]}"#;
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
        let empty = StateV5::empty();
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
        let mut invalid = StateV5::empty();
        // Slot 0 is valid, slot 1 is tampered; the whole update must fail and
        // must not half-apply slot 0.
        invalid.slots[0] = signed_slot(&key, 0, 1, Some(sample_entry()));
        let mut bad = signed_slot(&key, 1, 1, Some(sample_entry()));
        bad.entry.as_mut().unwrap().value = 999;
        invalid.slots[1] = bad;

        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
            vec![UpdateData::State(State::from(invalid.to_bytes()))],
        );
        assert!(err.is_err());

        // Sanity: the original state is untouched and still validates.
        assert!(valid.validate(&key.verifying_key()).is_ok());
    }

    #[test]
    fn update_state_rejects_invalid_contacts_atomically() {
        let key = test_key();
        let mut invalid = StateV5::empty();
        invalid.slots[0] = signed_slot(&key, 0, 1, Some(sample_entry()));
        invalid.contacts = signed_contacts(&key, 1, vec![contact("Alice", CONTACT_11)]);
        invalid.contacts.sig = Some(hex::encode([0u8; 64]));

        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
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
            payments: None,
            adjustments: None,
            slots: vec![
                DeltaSlot::from_slot(0, &first),
                DeltaSlot::from_slot(1, &second),
            ],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
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
            payments: None,
            adjustments: None,
            slots: vec![],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
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
        let mut b = StateV5::empty();
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

    fn summarize(state: &StateV5) -> StateSummary<'static> {
        NumberContract::summarize_state(
            Parameters::from(vec![0u8; 32]),
            State::from(state.to_bytes()),
        )
        .unwrap()
    }

    fn delta_from(state: &StateV5, summary: &StateSummary<'_>) -> StateDelta<'static> {
        NumberContract::get_state_delta(
            Parameters::from(vec![0u8; 32]),
            State::from(state.to_bytes()),
            StateSummary::from(summary.as_ref().to_vec()),
        )
        .unwrap()
    }

    #[test]
    fn initial_state_json_is_the_empty_board() {
        let initial: StateV5 = serde_json::from_str(include_str!("../initial_state.json")).unwrap();
        assert_eq!(initial, StateV5::empty());
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
        assert_eq!(
            summary["payments"],
            serde_json::json!([0, "00000000000000000000000000000000"])
        );
        assert_eq!(
            summary["adjustments"],
            serde_json::json!([0, "00000000000000000000000000000000"])
        );
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

        let mut delta_state = StateV5::empty();
        delta_state.slots[2] = signed_slot(&key, 2, 4, Some(sample_entry()));
        delta_state.contacts = signed_contacts(&key, 3, vec![contact("Alice", CONTACT_11)]);
        let delta = Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: Some(delta_state.contacts.clone()),
            payments: None,
            adjustments: None,
            slots: vec![DeltaSlot::from_slot(2, &delta_state.slots[2])],
        };
        let decoded: serde_json::Value = serde_json::from_slice(&delta.to_bytes()).unwrap();
        assert_eq!(decoded["v"], STATE_VERSION);
        assert!(decoded["parent"].is_null());
        assert!(decoded["payments"].is_null());
        assert!(decoded["adjustments"].is_null());
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
        let from = StateV5::empty();
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
        let mut before = StateV5::empty();
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
        let empty = StateV5::empty();
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
        let before = StateV5::empty();
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
        let mut local = StateV5::empty();
        local.parent = signed_parent(&key, 3, Some(CONTACT_11));
        let mut remote = StateV5::empty();
        remote.parent = signed_parent(&key, 3, Some(CONTACT_22));

        let delta = delta_from(&local, &summarize(&remote));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.parent.as_ref(), Some(&local.parent));
    }

    #[test]
    fn empty_summary_includes_parent() {
        let key = test_key();
        let mut state = StateV5::empty();
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
        let mut local = StateV5::empty();
        local.contacts = signed_contacts(&key, 3, vec![contact("Alice", CONTACT_11)]);
        let mut remote_summary_state = StateV5::empty();
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
            State::from(StateV5::empty().to_bytes()),
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
        let mut before = StateV5::empty();
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
            payments: None,
            adjustments: None,
            slots: vec![DeltaSlot::from_slot(8, &slot)],
        };
        let err = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
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
                "v": 5,
                "parent": [0, "11111111111111111111111111111111"],
                "contacts": [0, "00000000000000000000000000000000"],
                "payments": [0, "00000000000000000000000000000000"],
                "adjustments": [0, "00000000000000000000000000000000"],
                "slots": zero_slots.clone(),
            }),
            serde_json::json!({
                "v": 5,
                "parent": [0, "00000000000000000000000000000000"],
                "contacts": [0, "11111111111111111111111111111111"],
                "payments": [0, "00000000000000000000000000000000"],
                "adjustments": [0, "00000000000000000000000000000000"],
                "slots": zero_slots.clone(),
            }),
            serde_json::json!({
                "v": 5,
                "parent": [0, "00000000000000000000000000000000"],
                "contacts": [0, "00000000000000000000000000000000"],
                "payments": [0, "11111111111111111111111111111111"],
                "adjustments": [0, "00000000000000000000000000000000"],
                "slots": zero_slots.clone(),
            }),
            serde_json::json!({
                "v": 5,
                "parent": [0, "00000000000000000000000000000000"],
                "contacts": [0, "00000000000000000000000000000000"],
                "payments": [0, "00000000000000000000000000000000"],
                "adjustments": [0, "11111111111111111111111111111111"],
                "slots": zero_slots,
            }),
        ] {
            assert!(Summary::decode(bad.to_string().as_bytes()).is_err());
        }
    }

    // ---- payments ---------------------------------------------------------

    fn assert_payment_rejected(mutate: impl FnOnce(&mut Payment)) {
        let key = test_key();
        let mut payment = sample_payment();
        mutate(&mut payment);
        assert!(
            !signed_payments(&key, 1, Some(payment)).is_valid(&key.verifying_key()),
            "invalid payment must be rejected"
        );
    }

    #[test]
    fn payments_settled_field_is_optional_on_the_wire() {
        // A v3-upgrade record written before `settled` existed still decodes.
        let decoded: Payments =
            serde_json::from_str(r#"{"seq":1,"entry":null,"sig":null}"#).unwrap();
        assert!(decoded.settled.is_empty());

        // The canonical encoding always writes the list.
        assert_eq!(
            serde_json::to_string(&Payments::empty()).unwrap(),
            r#"{"seq":0,"settled":[],"entry":null,"sig":null}"#
        );
    }

    #[test]
    fn payments_empty_and_tombstone_are_valid() {
        let key = test_key();
        let verifying = key.verifying_key();
        assert!(Payments::empty().is_valid(&verifying));

        let tombstone = signed_tombstone(&key, 1);
        assert!(tombstone.entry.is_none());
        assert!(tombstone.is_valid(&verifying));

        let active = signed_payments(&key, 1, Some(sample_payment()));
        assert!(active.is_valid(&verifying));

        // Any field change invalidates the signature.
        let mut wrong = active.clone();
        let mut sig = hex::decode(wrong.sig.as_ref().unwrap()).unwrap();
        sig[0] ^= 1;
        wrong.sig = Some(hex::encode(sig));
        assert!(!wrong.is_valid(&verifying));
    }

    #[test]
    fn payments_seq_zero_requires_null_entry_and_signature() {
        let key = test_key();
        let verifying = key.verifying_key();

        let with_entry = Payments {
            seq: 0,
            settled: Vec::new(),
            entry: Some(sample_payment()),
            sig: None,
        };
        assert!(!with_entry.is_valid(&verifying));

        let stray_signature = Payments {
            seq: 0,
            settled: Vec::new(),
            entry: None,
            sig: Some(hex::encode([1u8; 64])),
        };
        assert!(!stray_signature.is_valid(&verifying));
    }

    #[test]
    fn payment_field_bounds_are_enforced() {
        // Id, owners and next are hex-shaped.
        assert_payment_rejected(|payment| {
            payment.id = "0123456789abcdef0123456789abcde".into();
        });
        assert_payment_rejected(|payment| {
            payment.id = "0123456789ABCDEF0123456789abcdef".into();
        });
        assert_payment_rejected(|payment| {
            payment.src = "11".repeat(31);
        });
        assert_payment_rejected(|payment| {
            payment.dst = "22".repeat(31) + "AA";
        });
        assert_payment_rejected(|payment| {
            payment.next = String::new();
        });

        // Amounts are positive.
        assert_payment_rejected(|payment| payment.amount = 0);
        assert_payment_rejected(|payment| payment.amount = -1);

        // Addresses are octal and at most 32 digits.
        assert_payment_rejected(|payment| payment.src_addr = "8".into());
        assert_payment_rejected(|payment| payment.src_addr = "0".repeat(MAX_ADDRESS_DIGITS + 1));
        assert_payment_rejected(|payment| payment.dst_addr = "a".into());
        assert_payment_rejected(|payment| payment.dst_addr = "7".repeat(MAX_ADDRESS_DIGITS + 1));

        // Cursor and enum strings.
        assert_payment_rejected(|payment| payment.cursor = MAX_PAYMENT_CURSOR + 1);
        assert_payment_rejected(|payment| payment.phase = "sideways".into());
        assert_payment_rejected(|payment| payment.status = "pending".into());
        assert_payment_rejected(|payment| payment.fail = Some("oops".into()));

        // Legs: at most two, unique slots, positive seq, 128 lowercase hex sig.
        assert_payment_rejected(|payment| {
            payment.legs = vec![
                sample_leg(0, 1, 1),
                sample_leg(1, 2, 2),
                sample_leg(2, 3, 3),
            ];
        });
        assert_payment_rejected(|payment| {
            payment.legs = vec![sample_leg(1, 1, 1), sample_leg(1, 2, 2)];
        });
        assert_payment_rejected(|payment| {
            payment.legs = vec![sample_leg(1, 0, 1)];
        });
        assert_payment_rejected(|payment| {
            payment.legs = vec![PaymentLeg {
                slot: 1,
                seq: 1,
                post_value: 1,
                sig: "5A".repeat(64),
            }];
        });
        assert_payment_rejected(|payment| {
            payment.legs = vec![PaymentLeg {
                slot: 1,
                seq: 1,
                post_value: 1,
                sig: "5a".repeat(63),
            }];
        });

        // Terminal payments point at nobody.
        assert_payment_rejected(|payment| {
            payment.phase = "terminal".into();
            payment.status = "complete".into();
        });

        // Conservative phase/status coherence.
        assert_payment_rejected(|payment| {
            payment.status = "offered".into();
            payment.cursor = 1;
        });
        assert_payment_rejected(|payment| {
            payment.status = "offered".into();
        });
        assert_payment_rejected(|payment| {
            payment.status = "complete".into();
        });
        assert_payment_rejected(|payment| {
            payment.status = "reversed".into();
        });
        assert_payment_rejected(|payment| {
            payment.status = "blocked".into();
        });
    }

    #[test]
    fn payment_protocol_boundaries_are_accepted() {
        let key = test_key();
        let verifying = key.verifying_key();

        // Longest address, highest cursor, explicit failure reason.
        let boundary = Payment {
            src_addr: "7".repeat(MAX_ADDRESS_DIGITS),
            dst_addr: "0".repeat(MAX_ADDRESS_DIGITS),
            cursor: MAX_PAYMENT_CURSOR,
            status: "reversing".into(),
            phase: "reverse".into(),
            fail: Some("address-mismatch".into()),
            ..sample_payment()
        };
        assert!(signed_payments(&key, 1, Some(boundary)).is_valid(&verifying));

        // An aborted intent at cursor 0 may have no legs.
        let aborted = Payment {
            cursor: 0,
            phase: "reverse".into(),
            status: "aborted".into(),
            fail: Some("negative".into()),
            legs: Vec::new(),
            ..sample_payment()
        };
        assert!(signed_payments(&key, 1, Some(aborted)).is_valid(&verifying));

        // The two-leg LCA form is valid.
        assert!(signed_payments(&key, 1, Some(terminal_payment())).is_valid(&verifying));
    }

    #[test]
    fn payments_merge_uses_seq_then_signature_bytes() {
        let key = test_key();
        let one_leg = signed_payments(&key, 1, Some(sample_payment()));
        let two_legs = signed_payments(&key, 1, Some(terminal_payment()));
        let expected = if payments_signature_bytes(&one_leg) >= payments_signature_bytes(&two_legs)
        {
            one_leg.clone()
        } else {
            two_legs.clone()
        };
        assert_eq!(merge_payments(&one_leg, &two_legs), expected);
        assert_eq!(merge_payments(&two_legs, &one_leg), expected);

        // Idempotent.
        assert_eq!(merge_payments(&one_leg, &one_leg), one_leg);

        // Higher seq wins, including a clearing tombstone.
        let newer = signed_payments(&key, 2, Some(terminal_payment()));
        assert_eq!(merge_payments(&one_leg, &newer), newer);
        assert_eq!(merge_payments(&newer, &one_leg), newer);

        let cleared = signed_tombstone(&key, 3);
        assert_eq!(cleared.entry, None);
        assert_eq!(merge_payments(&newer, &cleared), cleared);
        assert_eq!(merge_payments(&cleared, &newer), cleared);
        assert_eq!(merge_payments(&cleared, &cleared), cleared);
    }

    #[test]
    fn payments_settled_bounds_and_uniqueness_are_enforced() {
        let key = test_key();
        let verifying = key.verifying_key();

        let at_limit: Vec<String> = (0..MAX_SETTLED_PAYMENTS)
            .map(|index| payment_id(index as u8))
            .collect();
        assert!(
            signed_payments_with_settled(&key, 1, at_limit.clone(), Some(sample_payment()))
                .is_valid(&verifying)
        );

        let mut too_many = at_limit;
        too_many.push(payment_id(0xfe));
        assert!(
            !signed_payments_with_settled(&key, 1, too_many, Some(sample_payment()))
                .is_valid(&verifying)
        );

        let duplicate = vec![payment_id(1), payment_id(1)];
        assert!(
            !signed_payments_with_settled(&key, 1, duplicate, Some(sample_payment()))
                .is_valid(&verifying)
        );

        for bad in [
            String::new(),
            "aa".repeat(15),
            "aa".repeat(17),
            "AA".repeat(16),
            "zz".repeat(16),
        ] {
            assert!(
                !signed_payments_with_settled(&key, 1, vec![bad], Some(sample_payment()))
                    .is_valid(&verifying),
                "malformed settled id must be rejected"
            );
        }
    }

    #[test]
    fn payments_seq_zero_requires_empty_settled() {
        let key = test_key();
        let verifying = key.verifying_key();
        let record = Payments {
            seq: 0,
            settled: vec![payment_id(1)],
            entry: None,
            sig: None,
        };
        assert!(!record.is_valid(&verifying));
    }

    #[test]
    fn settled_participates_in_the_payments_signature() {
        let key = test_key();
        let verifying = key.verifying_key();
        let record =
            signed_payments_with_settled(&key, 4, vec![payment_id(1)], Some(sample_payment()));
        assert!(record.is_valid(&verifying));

        let mut replaced = record.clone();
        replaced.settled = vec![payment_id(2)];
        assert!(!replaced.is_valid(&verifying));

        let mut cleared = record.clone();
        cleared.settled.clear();
        assert!(!cleared.is_valid(&verifying));

        let mut reordered = signed_payments_with_settled(
            &key,
            4,
            vec![payment_id(1), payment_id(2)],
            Some(sample_payment()),
        );
        assert!(reordered.is_valid(&verifying));
        reordered.settled.swap(0, 1);
        assert!(!reordered.is_valid(&verifying));
    }

    #[test]
    fn payments_merge_moves_settled_with_the_whole_record() {
        let key = test_key();
        let older =
            signed_payments_with_settled(&key, 1, vec![payment_id(1)], Some(sample_payment()));
        let newer = signed_payments_with_settled(&key, 2, vec![payment_id(1), payment_id(2)], None);

        // A higher-seq tombstone clears the entry but keeps its settled ids.
        assert_eq!(merge_payments(&older, &newer), newer);
        assert_eq!(merge_payments(&newer, &older), newer);
        assert_eq!(newer.entry, None);
        assert_eq!(newer.settled, vec![payment_id(1), payment_id(2)]);

        // Equal seq resolves by signature bytes, and the winner's settled list
        // travels with it.
        let a = signed_payments_with_settled(&key, 3, vec![payment_id(3)], Some(sample_payment()));
        let b =
            signed_payments_with_settled(&key, 3, vec![payment_id(4)], Some(terminal_payment()));
        let expected = if payments_signature_bytes(&a) >= payments_signature_bytes(&b) {
            a.clone()
        } else {
            b.clone()
        };
        assert_eq!(merge_payments(&a, &b), expected);
        assert_eq!(merge_payments(&b, &a), expected);
        assert_eq!(expected.settled.len(), 1);
    }

    #[test]
    fn tombstone_can_retain_settled_ids() {
        let key = test_key();
        let verifying = key.verifying_key();
        let settled = vec![payment_id(1), payment_id(2)];
        let record = signed_payments_with_settled(&key, 5, settled.clone(), None);
        assert!(record.entry.is_none());
        assert_eq!(record.settled, settled);
        assert!(record.is_valid(&verifying));
    }

    #[test]
    fn payments_delta_round_trips_settled() {
        let key = test_key();
        let before = StateV5::empty();
        let mut after = before.clone();
        after.payments = signed_payments_with_settled(
            &key,
            1,
            vec![payment_id(0xaa), payment_id(0xbb)],
            Some(sample_payment()),
        );

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.payments.as_ref(), Some(&after.payments));
        assert!(parsed.slots.is_empty());

        let synced = NumberContract::update_state(
            params(&key),
            State::from(before.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), after.to_bytes().as_slice());
        assert_eq!(delta_from(&after, &summarize(&after)).size(), 0);

        // Same seq and entry but different settled ids is a different signed
        // record, so the summary digest must diverge and heals through a delta.
        let mut diverged = after.clone();
        diverged.payments =
            signed_payments_with_settled(&key, 1, vec![payment_id(0xaa)], Some(sample_payment()));
        assert_ne!(
            Summary::of(&after).payments,
            Summary::of(&diverged).payments
        );
        let heal = delta_from(&diverged, &summarize(&after));
        let parsed = Delta::decode(heal.as_ref()).unwrap();
        assert_eq!(parsed.payments.as_ref(), Some(&diverged.payments));
    }

    #[test]
    fn update_state_merges_payments_from_full_state_and_delta() {
        let key = test_key();
        let base = populated_state(&key);
        let incoming = signed_payments(&key, 4, Some(sample_payment()));

        let mut full = base.clone();
        full.payments = incoming.clone();
        let updated = NumberContract::update_state(
            params(&key),
            State::from(base.to_bytes()),
            vec![UpdateData::State(State::from(full.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(
            StateV5::decode(updated.as_ref()).unwrap().payments,
            incoming
        );

        let delta_payments = signed_payments(&key, 5, Some(terminal_payment()));
        let delta = Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: None,
            payments: Some(delta_payments.clone()),
            adjustments: None,
            slots: vec![],
        };
        let updated = NumberContract::update_state(
            params(&key),
            State::from(StateV5::decode(updated.as_ref()).unwrap().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(
            StateV5::decode(updated.as_ref()).unwrap().payments,
            delta_payments
        );

        // A stale record loses the merge without an error.
        let stale = Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: None,
            payments: Some(signed_payments(&key, 2, Some(sample_payment()))),
            adjustments: None,
            slots: vec![],
        };
        let updated = NumberContract::update_state(
            params(&key),
            State::from(StateV5::decode(updated.as_ref()).unwrap().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(stale.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(
            StateV5::decode(updated.as_ref()).unwrap().payments,
            delta_payments
        );
    }

    #[test]
    fn summary_includes_payments_digest_and_zeros_when_empty() {
        let key = test_key();
        let empty = StateV5::empty();
        let summary = Summary::of(&empty);
        assert_eq!(summary.payments.0, 0);
        assert_eq!(summary.payments.1, "0".repeat(32));

        let mut state = empty;
        state.payments = signed_payments(&key, 2, Some(sample_payment()));
        let summary = Summary::of(&state);
        assert_eq!(summary.payments.0, 2);
        assert_eq!(
            summary.payments.1,
            hex::encode(digest16(&payments_signing_bytes(
                2,
                &state.payments.settled,
                state.payments.entry.as_ref()
            )))
        );

        let decoded = Summary::decode(&summary.to_bytes()).unwrap();
        assert_eq!(decoded, summary);
    }

    #[test]
    fn payments_delta_round_trips_and_clear() {
        let key = test_key();
        let before = StateV5::empty();
        let mut after = before.clone();
        after.payments = signed_payments(&key, 1, Some(sample_payment()));

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.payments.as_ref(), Some(&after.payments));
        assert!(parsed.parent.is_none());
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

        // Converged peers get nothing, payments included.
        assert_eq!(delta_from(&after, &summarize(&after)).size(), 0);

        // A higher-seq tombstone is sent and clears the payment.
        let mut cleared = after.clone();
        cleared.payments = signed_tombstone(&key, 2);
        let delta = delta_from(&cleared, &summarize(&after));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.payments.as_ref(), Some(&cleared.payments));
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
    fn get_state_delta_heals_equal_payments_seq_with_different_digest() {
        let key = test_key();
        let mut local = StateV5::empty();
        local.payments = signed_payments(&key, 3, Some(sample_payment()));
        let mut remote = StateV5::empty();
        remote.payments = signed_payments(&key, 3, Some(terminal_payment()));

        let delta = delta_from(&local, &summarize(&remote));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.payments.as_ref(), Some(&local.payments));
    }

    #[test]
    fn empty_summary_includes_payments() {
        let key = test_key();
        let mut state = StateV5::empty();
        state.payments = signed_payments(&key, 1, Some(sample_payment()));

        let delta = delta_from(&state, &StateSummary::from(vec![]));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.payments.as_ref(), Some(&state.payments));
    }

    #[test]
    fn older_state_shapes_are_not_accepted() {
        let key = test_key();
        let v3 = r#"{"v":3,"parent":{"seq":0,"userId":null,"sig":null},"contacts":{"seq":0,"entries":[],"sig":null},"slots":[{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null}]}"#;
        assert_eq!(
            NumberContract::validate_state(
                params(&key),
                State::from(v3.as_bytes().to_vec()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );

        // v4 without the payments field also fails to decode.
        let missing_payments = r#"{"v":4,"parent":{"seq":0,"userId":null,"sig":null},"contacts":{"seq":0,"entries":[],"sig":null},"slots":[{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null}]}"#;
        assert!(StateV5::decode(missing_payments.as_bytes()).is_err());

        // A complete v4 state has no adjustments field and is rejected.
        let v4 = r#"{"v":4,"parent":{"seq":0,"userId":null,"sig":null},"contacts":{"seq":0,"entries":[],"sig":null},"payments":{"seq":0,"settled":[],"entry":null,"sig":null},"slots":[{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null}]}"#;
        assert!(StateV5::decode(v4.as_bytes()).is_err());

        // v5 without the adjustments field also fails to decode.
        let missing_adjustments = r#"{"v":5,"parent":{"seq":0,"userId":null,"sig":null},"contacts":{"seq":0,"entries":[],"sig":null},"payments":{"seq":0,"settled":[],"entry":null,"sig":null},"slots":[{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null}]}"#;
        assert!(StateV5::decode(missing_adjustments.as_bytes()).is_err());
    }

    #[test]
    fn summary_and_delta_reject_the_previous_version() {
        let key = test_key();
        let state = populated_state(&key);

        let mut summary: serde_json::Value =
            serde_json::from_slice(&Summary::of(&state).to_bytes()).unwrap();
        summary["v"] = serde_json::json!(4);
        assert!(Summary::decode(&serde_json::to_vec(&summary).unwrap()).is_err());

        let mut delta: serde_json::Value = serde_json::from_slice(
            &Delta {
                v: STATE_VERSION,
                parent: None,
                contacts: Some(state.contacts.clone()),
                payments: None,
                adjustments: None,
                slots: vec![],
            }
            .to_bytes(),
        )
        .unwrap();
        delta["v"] = serde_json::json!(4);
        let error = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(
                serde_json::to_vec(&delta).unwrap(),
            ))],
        );
        assert!(error.is_err());
    }

    #[test]
    fn v5_empty_state_round_trips() {
        let key = test_key();
        let empty = StateV5::empty();
        let decoded = StateV5::decode(&empty.to_bytes()).unwrap();
        assert_eq!(decoded, empty);
        assert_eq!(decoded.v, 5);
        assert_eq!(decoded.payments, Payments::empty());
        assert_eq!(decoded.adjustments, Adjustments::empty());
        assert!(decoded.validate(&key.verifying_key()).is_ok());
    }

    /// The v4 -> v5 client upgrade only adds an empty adjustments record and
    /// bumps `v`. Every v2/v3/v4 signature stays valid.
    #[test]
    fn v4_state_upgrades_to_v5_by_adding_an_empty_adjustments_record() {
        let key = test_key();
        let mut state = populated_state(&key);
        state.payments = signed_payments(&key, 4, Some(sample_payment()));

        let mut json: serde_json::Value = serde_json::from_slice(&state.to_bytes()).unwrap();
        json.as_object_mut().unwrap().remove("adjustments");
        json["v"] = serde_json::json!(4);
        let v4_bytes = serde_json::to_vec(&json).unwrap();
        assert!(StateV5::decode(&v4_bytes).is_err());

        json["v"] = serde_json::json!(5);
        json["adjustments"] = serde_json::json!({"seq": 0, "entries": [], "sig": null});
        let upgraded = StateV5::decode(&serde_json::to_vec(&json).unwrap()).unwrap();
        assert_eq!(upgraded, state);
        assert!(upgraded.validate(&key.verifying_key()).is_ok());
    }

    // ---- adjustments ------------------------------------------------------

    fn sample_adjustment() -> Adjustment {
        Adjustment {
            slot: 2,
            slot_seq: 4,
            delta: 25,
            post_value: 125,
            note: Some("issue".into()),
        }
    }

    fn entry_with_value(value: i64) -> Entry {
        Entry {
            value,
            contact: CONTACT_11.into(),
            unit: None,
            note: None,
        }
    }

    fn apply_delta(
        key: &SigningKey,
        state: &StateV5,
        delta: Delta,
    ) -> Result<StateV5, ContractError> {
        NumberContract::update_state(
            params(key),
            State::from(state.to_bytes()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_bytes()))],
        )
        .map(|updated| StateV5::decode(updated.unwrap_valid().as_ref()).unwrap())
    }

    fn adjustments_delta(adjustments: Adjustments, slots: Vec<(u8, Slot)>) -> Delta {
        Delta {
            v: STATE_VERSION,
            parent: None,
            contacts: None,
            payments: None,
            adjustments: Some(adjustments),
            slots: slots
                .into_iter()
                .map(|(index, slot)| DeltaSlot::from_slot(index, &slot))
                .collect(),
        }
    }

    #[test]
    fn adjustment_wire_shape_matches_the_client_codec() {
        let key = test_key();
        let record = signed_adjustments(&key, 1, vec![sample_adjustment()]);
        let json: serde_json::Value =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(json["entries"][0]["slot"], 2);
        assert_eq!(json["entries"][0]["slotSeq"], 4);
        assert_eq!(json["entries"][0]["delta"], 25);
        assert_eq!(json["entries"][0]["postValue"], 125);
        assert_eq!(json["entries"][0]["note"], "issue");
        assert!(json["entries"][0].get("slot_seq").is_none());
        assert!(json["entries"][0].get("post_value").is_none());

        // The client's camelCase JSON decodes to the same record.
        let decoded: Adjustments = serde_json::from_value(json).unwrap();
        assert_eq!(decoded, record);
    }

    #[test]
    fn golden_adjustments_signing_bytes_are_pinned() {
        let entries = vec![
            Adjustment {
                slot: 1,
                slot_seq: 4,
                delta: 500,
                post_value: 3750,
                note: Some("issue".into()),
            },
            Adjustment {
                slot: 3,
                slot_seq: 5,
                delta: -250,
                post_value: 1000,
                note: None,
            },
        ];
        let bytes = adjustments_signing_bytes(6, &entries);
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76353a61646a7573746d656e7473060000000000000002000000010400000000000000f401000000000000a60e00000000000005000000697373756503050000000000000006ffffffffffffffe80300000000000000000000"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "77e51bf4156a440a0dd97456f350918a"
        );

        // A single entry with a null note signs note_len = 0.
        let single = vec![Adjustment {
            slot: 0,
            slot_seq: 1,
            delta: 7,
            post_value: 7,
            note: None,
        }];
        let bytes = adjustments_signing_bytes(1, &single);
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76353a61646a7573746d656e74730100000000000000010000000001000000000000000700000000000000070000000000000000000000"
        );
        assert_eq!(
            hex::encode(digest16(&bytes)),
            "33a936e304f242accf347d520f5f616c"
        );

        // `seq == 0` is never signed, but the encoder stays deterministic.
        let mut zero = SIGNING_DOMAIN_ADJUSTMENTS.to_vec();
        zero.extend_from_slice(&0u64.to_le_bytes());
        zero.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(adjustments_signing_bytes(0, &[]), zero);
    }

    #[test]
    fn adjustments_seq_zero_requires_empty_entries_and_null_sig() {
        let key = test_key();
        let verifying = key.verifying_key();
        assert!(Adjustments::empty().is_valid(&verifying));

        let with_entry = Adjustments {
            seq: 0,
            entries: vec![sample_adjustment()],
            sig: None,
        };
        assert!(!with_entry.is_valid(&verifying));

        let stray_signature = Adjustments {
            seq: 0,
            entries: Vec::new(),
            sig: Some(hex::encode([1u8; 64])),
        };
        assert!(!stray_signature.is_valid(&verifying));
    }

    #[test]
    fn adjustment_bounds_are_enforced() {
        let key = test_key();
        let verifying = key.verifying_key();

        assert!(signed_adjustments(&key, 1, vec![sample_adjustment()]).is_valid(&verifying));

        for bad in [
            Adjustment {
                slot: 8,
                ..sample_adjustment()
            },
            Adjustment {
                slot_seq: 0,
                ..sample_adjustment()
            },
            Adjustment {
                delta: 0,
                ..sample_adjustment()
            },
            Adjustment {
                post_value: -1,
                ..sample_adjustment()
            },
            // Implied pre-value would be negative.
            Adjustment {
                delta: 5,
                post_value: 4,
                ..sample_adjustment()
            },
            // Implied pre-value would overflow.
            Adjustment {
                delta: -1,
                post_value: i64::MAX,
                ..sample_adjustment()
            },
            Adjustment {
                delta: i64::MIN,
                ..sample_adjustment()
            },
            Adjustment {
                note: Some("n".repeat(MAX_ADJUSTMENT_NOTE_BYTES + 1)),
                ..sample_adjustment()
            },
        ] {
            assert!(
                !signed_adjustments(&key, 1, vec![bad]).is_valid(&verifying),
                "invalid adjustment must be rejected"
            );
        }

        // Inclusive boundaries.
        for good in [
            Adjustment {
                note: Some("n".repeat(MAX_ADJUSTMENT_NOTE_BYTES)),
                ..sample_adjustment()
            },
            Adjustment {
                delta: 1,
                post_value: 1,
                ..sample_adjustment()
            },
            Adjustment {
                delta: -125,
                post_value: 0,
                ..sample_adjustment()
            },
        ] {
            assert!(signed_adjustments(&key, 1, vec![good]).is_valid(&verifying));
        }

        // The entry count is capped at 32.
        let entries: Vec<Adjustment> = (0..MAX_ADJUSTMENTS)
            .map(|index| Adjustment {
                slot: (index % SLOT_COUNT) as u8,
                slot_seq: (index / SLOT_COUNT + 1) as u64,
                delta: 1,
                post_value: 1,
                note: None,
            })
            .collect();
        assert!(signed_adjustments(&key, 1, entries.clone()).is_valid(&verifying));
        let mut too_many = entries;
        too_many.push(Adjustment {
            slot: 7,
            slot_seq: 100,
            delta: 1,
            post_value: 1,
            note: None,
        });
        assert!(!signed_adjustments(&key, 1, too_many).is_valid(&verifying));
    }

    #[test]
    fn adjustments_reject_duplicate_and_decreasing_slot_seq() {
        let key = test_key();
        let verifying = key.verifying_key();

        let duplicate = vec![
            Adjustment {
                slot: 1,
                slot_seq: 3,
                delta: 1,
                post_value: 1,
                note: None,
            },
            Adjustment {
                slot: 1,
                slot_seq: 3,
                delta: 2,
                post_value: 3,
                note: None,
            },
        ];
        assert!(!signed_adjustments(&key, 1, duplicate).is_valid(&verifying));

        let decreasing = vec![
            Adjustment {
                slot: 1,
                slot_seq: 3,
                delta: 1,
                post_value: 1,
                note: None,
            },
            Adjustment {
                slot: 1,
                slot_seq: 2,
                delta: 2,
                post_value: 3,
                note: None,
            },
        ];
        assert!(!signed_adjustments(&key, 1, decreasing).is_valid(&verifying));

        // Same slot_seq on different slots, and interleaved per-slot increase,
        // are allowed.
        let good = vec![
            Adjustment {
                slot: 1,
                slot_seq: 3,
                delta: 1,
                post_value: 1,
                note: None,
            },
            Adjustment {
                slot: 2,
                slot_seq: 3,
                delta: 1,
                post_value: 1,
                note: None,
            },
            Adjustment {
                slot: 1,
                slot_seq: 4,
                delta: 1,
                post_value: 2,
                note: None,
            },
        ];
        assert!(signed_adjustments(&key, 1, good).is_valid(&verifying));
    }

    #[test]
    fn adjustment_signature_covers_every_field() {
        let key = test_key();
        let verifying = key.verifying_key();
        let record = signed_adjustments(&key, 2, vec![sample_adjustment()]);
        assert!(record.is_valid(&verifying));

        let mut changed_slot = record.clone();
        changed_slot.entries[0].slot = 3;
        assert!(!changed_slot.is_valid(&verifying));

        let mut changed_seq = record.clone();
        changed_seq.seq = 3;
        assert!(!changed_seq.is_valid(&verifying));

        let mut changed_slot_seq = record.clone();
        changed_slot_seq.entries[0].slot_seq = 5;
        assert!(!changed_slot_seq.is_valid(&verifying));

        let mut changed_delta = record.clone();
        changed_delta.entries[0].delta = 26;
        assert!(!changed_delta.is_valid(&verifying));

        let mut changed_post = record.clone();
        changed_post.entries[0].post_value = 126;
        assert!(!changed_post.is_valid(&verifying));

        let mut changed_note = record.clone();
        changed_note.entries[0].note = Some("burn".into());
        assert!(!changed_note.is_valid(&verifying));

        let mut changed_sig = record;
        let mut sig = hex::decode(changed_sig.sig.as_ref().unwrap()).unwrap();
        sig[0] ^= 1;
        changed_sig.sig = Some(hex::encode(sig));
        assert!(!changed_sig.is_valid(&verifying));
    }

    /// Build a board whose slot 2 is 100 at seq 3 and whose log says the next
    /// write (seq 4) issued 25 to reach 125.
    fn provenance_state(key: &SigningKey) -> StateV5 {
        let mut state = StateV5::empty();
        state.slots[2] = signed_slot(key, 2, 3, Some(entry_with_value(100)));
        state.adjustments = signed_adjustments(key, 1, vec![sample_adjustment()]);
        state
    }

    #[test]
    fn provenance_accepts_the_matching_slot_write() {
        let key = test_key();
        let state = provenance_state(&key);
        let written = signed_slot(&key, 2, 5, Some(entry_with_value(150)));
        let next = signed_adjustments(
            &key,
            2,
            vec![Adjustment {
                slot: 2,
                slot_seq: 5,
                delta: 50,
                post_value: 150,
                note: Some("issue".into()),
            }],
        );
        let delta = adjustments_delta(next.clone(), vec![(2, written)]);

        let updated = apply_delta(&key, &state, delta.clone()).expect("matching write is valid");
        assert_eq!(updated.slots[2].seq, 5);
        assert_eq!(updated.slots[2].entry.as_ref().unwrap().value, 150);
        assert_eq!(updated.adjustments, next);

        // Re-applying the same delta is a no-op even though the entries are now
        // history (they need no slot write the second time).
        let again = apply_delta(&key, &updated, delta).unwrap();
        assert_eq!(again.to_bytes(), updated.to_bytes());
    }

    #[test]
    fn provenance_rejects_a_missing_slot_write() {
        let key = test_key();
        let state = provenance_state(&key);
        let newer = signed_adjustments(
            &key,
            2,
            vec![
                sample_adjustment(),
                Adjustment {
                    slot: 2,
                    slot_seq: 5,
                    delta: 25,
                    post_value: 150,
                    note: None,
                },
            ],
        );
        let delta = adjustments_delta(newer, vec![]);
        assert!(apply_delta(&key, &state, delta).is_err());
    }

    #[test]
    fn provenance_rejects_a_mismatched_slot_write() {
        let key = test_key();
        let state = provenance_state(&key);
        let next = |delta: i64, post_value: i64, slot_seq: u64| Adjustment {
            slot: 2,
            slot_seq,
            delta,
            post_value,
            note: None,
        };

        // Wrong post value: the slot was written to 149, the log says 150.
        let wrong_value = signed_slot(&key, 2, 5, Some(entry_with_value(149)));
        let delta = adjustments_delta(
            signed_adjustments(&key, 2, vec![next(50, 150, 5)]),
            vec![(2, wrong_value)],
        );
        assert!(apply_delta(&key, &state, delta).is_err());

        // Right value, wrong delta.
        let written = signed_slot(&key, 2, 5, Some(entry_with_value(150)));
        let delta = adjustments_delta(
            signed_adjustments(&key, 2, vec![next(40, 150, 5)]),
            vec![(2, written)],
        );
        assert!(apply_delta(&key, &state, delta).is_err());

        // Right value and delta, wrong slot_seq.
        let written = signed_slot(&key, 2, 5, Some(entry_with_value(150)));
        let delta = adjustments_delta(
            signed_adjustments(&key, 2, vec![next(50, 150, 4)]),
            vec![(2, written)],
        );
        assert!(apply_delta(&key, &state, delta).is_err());

        // Right slot write, but the pre-update value disagrees with the delta.
        let mut drifted = state.clone();
        drifted.slots[2] = signed_slot(&key, 2, 3, Some(entry_with_value(90)));
        let written = signed_slot(&key, 2, 5, Some(entry_with_value(125)));
        let delta = adjustments_delta(
            signed_adjustments(&key, 2, vec![next(25, 125, 5)]),
            vec![(2, written)],
        );
        assert!(apply_delta(&key, &drifted, delta).is_err());
    }

    #[test]
    fn full_state_updates_skip_provenance() {
        let key = test_key();
        // A full state may carry an adjustment/slot mismatch: validation only
        // checks signatures and bounds (the migration path).
        let mut full = StateV5::empty();
        full.slots[2] = signed_slot(&key, 2, 4, Some(entry_with_value(999)));
        full.adjustments = signed_adjustments(&key, 1, vec![sample_adjustment()]);
        assert!(full.validate(&key.verifying_key()).is_ok());

        let updated = NumberContract::update_state(
            params(&key),
            State::from(StateV5::empty().to_bytes()),
            vec![UpdateData::State(State::from(full.to_bytes()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(updated.as_ref(), full.to_bytes().as_slice());
    }

    #[test]
    fn adjustments_merge_uses_seq_then_signature_bytes() {
        let key = test_key();
        let issued = signed_adjustments(&key, 1, vec![sample_adjustment()]);
        let burned = signed_adjustments(
            &key,
            1,
            vec![Adjustment {
                delta: -25,
                post_value: 75,
                note: Some("burn".into()),
                ..sample_adjustment()
            }],
        );
        let expected =
            if adjustments_signature_bytes(&issued) >= adjustments_signature_bytes(&burned) {
                issued.clone()
            } else {
                burned.clone()
            };
        assert_eq!(merge_adjustments(&issued, &burned), expected);
        assert_eq!(merge_adjustments(&burned, &issued), expected);
        assert_eq!(merge_adjustments(&issued, &issued), issued);

        // A higher seq replaces the whole log.
        let newer = signed_adjustments(&key, 2, vec![]);
        assert_eq!(merge_adjustments(&issued, &newer), newer);
        assert_eq!(merge_adjustments(&newer, &issued), newer);
        assert!(newer.entries.is_empty());

        // An empty record loses to any signed record.
        assert_eq!(merge_adjustments(&Adjustments::empty(), &issued), issued);
    }

    #[test]
    fn update_state_merges_adjustments_from_delta() {
        let key = test_key();
        let state = provenance_state(&key);
        let written = signed_slot(&key, 2, 4, Some(entry_with_value(125)));
        let delta = adjustments_delta(state.adjustments.clone(), vec![(2, written)]);

        let updated = apply_delta(&key, &state, delta).unwrap();
        assert_eq!(updated.adjustments, state.adjustments);
        assert_eq!(
            StateV5::decode(
                NumberContract::update_state(
                    params(&key),
                    State::from(state.to_bytes()),
                    vec![UpdateData::State(State::from(updated.to_bytes()))],
                )
                .unwrap()
                .unwrap_valid()
                .as_ref()
            )
            .unwrap(),
            updated
        );
    }

    #[test]
    fn summary_includes_adjustments_digest_and_zeros_when_empty() {
        let key = test_key();
        let empty = StateV5::empty();
        let summary = Summary::of(&empty);
        assert_eq!(summary.adjustments.0, 0);
        assert_eq!(summary.adjustments.1, "0".repeat(32));

        let state = provenance_state(&key);
        let summary = Summary::of(&state);
        assert_eq!(summary.adjustments.0, 1);
        assert_eq!(
            summary.adjustments.1,
            hex::encode(digest16(&adjustments_signing_bytes(
                1,
                &state.adjustments.entries
            )))
        );

        let decoded = Summary::decode(&summary.to_bytes()).unwrap();
        assert_eq!(decoded, summary);
    }

    #[test]
    fn adjustments_delta_round_trips() {
        let key = test_key();
        let mut before = StateV5::empty();
        before.slots[2] = signed_slot(&key, 2, 3, Some(entry_with_value(100)));
        let mut after = before.clone();
        after.slots[2] = signed_slot(&key, 2, 4, Some(entry_with_value(125)));
        after.adjustments = signed_adjustments(&key, 1, vec![sample_adjustment()]);

        let delta = delta_from(&after, &summarize(&before));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.adjustments.as_ref(), Some(&after.adjustments));
        assert_eq!(parsed.slots.len(), 1);

        let synced = NumberContract::update_state(
            params(&key),
            State::from(before.to_bytes()),
            vec![UpdateData::Delta(delta)],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(synced.as_ref(), after.to_bytes().as_slice());
        assert_eq!(delta_from(&after, &summarize(&after)).size(), 0);
    }

    #[test]
    fn get_state_delta_heals_equal_adjustments_seq_with_different_digest() {
        let key = test_key();
        let mut local = StateV5::empty();
        local.adjustments = signed_adjustments(&key, 3, vec![sample_adjustment()]);
        let mut remote = StateV5::empty();
        remote.adjustments = signed_adjustments(
            &key,
            3,
            vec![Adjustment {
                delta: -25,
                post_value: 75,
                note: None,
                ..sample_adjustment()
            }],
        );

        let delta = delta_from(&local, &summarize(&remote));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.adjustments.as_ref(), Some(&local.adjustments));
    }

    #[test]
    fn empty_summary_includes_adjustments() {
        let key = test_key();
        let state = provenance_state(&key);
        let delta = delta_from(&state, &StateSummary::from(vec![]));
        let parsed = Delta::decode(delta.as_ref()).unwrap();
        assert_eq!(parsed.adjustments.as_ref(), Some(&state.adjustments));
    }

    /// Adjustments and slots merge independently. A legitimate merge can leave an
    /// adjustment whose referenced slot write was superseded by a newer one; the
    /// merged state must still validate (merge-invariance).
    #[test]
    fn merged_states_stay_valid_with_an_adjustment_slot_mismatch() {
        let key = test_key();
        let mut a = StateV5::empty();
        a.slots[0] = signed_slot(&key, 0, 2, Some(entry_with_value(100)));
        a.adjustments = signed_adjustments(
            &key,
            2,
            vec![Adjustment {
                slot: 0,
                slot_seq: 2,
                delta: 100,
                post_value: 100,
                note: Some("issue".into()),
            }],
        );

        let mut b = StateV5::empty();
        b.slots[0] = signed_slot(&key, 0, 3, Some(entry_with_value(50)));
        b.adjustments = signed_adjustments(
            &key,
            1,
            vec![Adjustment {
                slot: 0,
                slot_seq: 3,
                delta: 50,
                post_value: 50,
                note: None,
            }],
        );

        assert!(a.validate(&key.verifying_key()).is_ok());
        assert!(b.validate(&key.verifying_key()).is_ok());

        let result = merged(&a, &b);
        assert_eq!(result.adjustments, a.adjustments);
        assert_eq!(result.slots[0], b.slots[0]);
        assert!(result.validate(&key.verifying_key()).is_ok());
        assert_eq!(result.to_bytes(), merged(&b, &a).to_bytes());
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

    fn arb_payment_entry() -> impl Strategy<Value = Payment> {
        prop_oneof![
            Just(sample_payment()),
            Just(terminal_payment()),
            Just(Payment {
                cursor: 3,
                phase: "reverse".into(),
                status: "reversing".into(),
                fail: Some("blocked".into()),
                next: CONTACT_11.into(),
                legs: vec![sample_leg(0, 2, 100)],
                ..sample_payment()
            }),
        ]
    }

    fn arb_settled() -> impl Strategy<Value = Vec<String>> {
        proptest::collection::vec(any::<u8>(), 0..=MAX_SETTLED_PAYMENTS).prop_map(|tags| {
            tags.into_iter()
                .enumerate()
                .map(|(index, tag)| {
                    // Make ids unique inside the record regardless of the tag.
                    let mut raw = [tag; 16];
                    raw[15] = index as u8;
                    hex::encode(raw)
                })
                .collect()
        })
    }

    fn arb_payments() -> impl Strategy<Value = Payments> {
        (
            0u64..=100,
            prop::option::of(arb_payment_entry()),
            arb_settled(),
        )
            .prop_map(|(seq, entry, settled)| {
                if seq == 0 {
                    Payments::empty()
                } else {
                    signed_payments_with_settled(&test_key(), seq, settled, entry)
                }
            })
    }

    /// A valid `(delta, post_value)` pair with a non-negative implied pre-value.
    fn arb_adjustment_amounts() -> impl Strategy<Value = (i64, i64)> {
        (0i64..=100_000, 1i64..=1_000, any::<bool>()).prop_map(|(base, magnitude, issue)| {
            if issue {
                (magnitude, base + magnitude)
            } else {
                (-magnitude, base)
            }
        })
    }

    /// Generate 0..=8 valid adjustment entries, per-slot `slot_seq` increasing.
    fn arb_adjustment_entries() -> impl Strategy<Value = Vec<Adjustment>> {
        proptest::collection::vec(
            (
                0u8..SLOT_COUNT as u8,
                arb_adjustment_amounts(),
                prop::option::of(arb_ascii(MAX_ADJUSTMENT_NOTE_BYTES)),
            ),
            0..=8,
        )
        .prop_map(|specs| {
            let mut counters = [0u64; SLOT_COUNT];
            specs
                .into_iter()
                .map(|(slot, (delta, post_value), note)| {
                    counters[usize::from(slot)] += 1;
                    Adjustment {
                        slot,
                        slot_seq: counters[usize::from(slot)],
                        delta,
                        post_value,
                        note,
                    }
                })
                .collect()
        })
    }

    fn arb_adjustments() -> impl Strategy<Value = Adjustments> {
        (0u64..=100, arb_adjustment_entries()).prop_map(|(seq, entries)| {
            if seq == 0 {
                Adjustments::empty()
            } else {
                signed_adjustments(&test_key(), seq, entries)
            }
        })
    }

    fn arb_state() -> impl Strategy<Value = StateV5> {
        (
            arb_parent(),
            arb_contacts(),
            arb_payments(),
            arb_adjustments(),
            proptest::collection::vec(arb_slot_spec(), SLOT_COUNT),
        )
            .prop_map(|(parent, contacts, payments, adjustments, specs)| {
                let key = test_key();
                let slots = std::array::from_fn(|index| match &specs[index] {
                    SlotSpec::Empty => Slot::empty(),
                    SlotSpec::Tombstone(seq) => signed_slot(&key, index as u8, *seq, None),
                    SlotSpec::Value(seq, entry) => {
                        signed_slot(&key, index as u8, *seq, Some(entry.clone()))
                    }
                });
                StateV5 {
                    v: STATE_VERSION,
                    parent,
                    contacts,
                    payments,
                    adjustments,
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
            let empty = StateV5::empty();
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
            prop_assert_eq!(result.payments, merge_payments(&a.payments, &b.payments));
            prop_assert_eq!(
                result.adjustments,
                merge_adjustments(&a.adjustments, &b.adjustments)
            );
            for index in 0..SLOT_COUNT {
                prop_assert_eq!(
                    result.slots[index].to_owned(),
                    merge_slot(&a.slots[index], &b.slots[index])
                );
            }
        }

        #[test]
        fn adjustments_merge_is_commutative_and_associative(
            a in arb_adjustments(),
            b in arb_adjustments(),
            c in arb_adjustments(),
        ) {
            let ab = merge_adjustments(&a, &b);
            let ba = merge_adjustments(&b, &a);
            prop_assert_eq!(ab.clone(), ba);
            prop_assert_eq!(
                merge_adjustments(&ab, &c),
                merge_adjustments(&a, &merge_adjustments(&b, &c))
            );
            prop_assert_eq!(merge_adjustments(&a, &a), a.clone());
            prop_assert!(a.is_valid(&test_key().verifying_key()));
        }

        /// An adjustment log and slots are generated independently, so merges
        /// routinely pair an adjustment with a slot write that superseded it.
        /// That mismatch must never make the merged state invalid.
        #[test]
        fn merged_adjustment_slot_mismatches_stay_valid(a in arb_state(), b in arb_state()) {
            let key = test_key();
            let result = merged(&a, &b);
            prop_assert!(result.validate(&key.verifying_key()).is_ok());
        }
    }
}
