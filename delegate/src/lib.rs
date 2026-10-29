//! `number-delegate` — private key custody, slot signing and address-book
//! signing for the number app.
//!
//! The delegate owns a single Ed25519 key pair. The 32-byte seed, a per-slot
//! monotonic sequence counter, a contacts sequence counter, a parent sequence
//! counter and a payments sequence counter live in the delegate's secret
//! store; the matching public key is the owner key the
//! `number-contract` instance is parameterised by. The delegate itself is
//! parameterised by the web container contract id it serves, and refuses every
//! other caller.
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

pub mod advance;

use advance::{AdvanceError, BoardState, LegPlan, OwnBoard, audit_slots};

/// Number of slots on a board.
pub const SLOT_COUNT: usize = 8;

/// Maximum number of contacts in the address book.
pub const MAX_CONTACTS: usize = 64;
/// Maximum length of a contact label in UTF-8 bytes.
pub const MAX_CONTACT_LABEL_BYTES: usize = 64;
/// Metadata bounds from `DESIGN.md` §2, in UTF-8 bytes.
pub const MAX_UNIT_BYTES: usize = 16;
pub const MAX_NOTE_BYTES: usize = 512;

/// Length of a `userId`/`contact` hex string (32 raw bytes).
pub const USER_ID_HEX_LEN: usize = 64;

/// Length of the webapp contract instance id carried in the delegate params.
pub const WEBAPP_ID_LEN: usize = 32;

/// Bumped when the delegate protocol changes; reported by `status`/`export`.
pub const DELEGATE_VERSION: u32 = 8;

/// Secret-store key holding the raw 32-byte Ed25519 seed.
pub const SECRET_SEED: &[u8] = b"number.v1.seed";

/// Prefix for the per-slot `u64` little-endian next-sequence key.
pub const NEXTSEQ_PREFIX: &str = "number.v1.nextseq.";

/// Secret-store key holding the contacts `u64` little-endian next-sequence.
pub const CONTACTS_NEXTSEQ_KEY: &[u8] = b"number.v2.nextseq.contacts";

/// Secret-store key holding the parent `u64` little-endian next-sequence.
pub const PARENT_NEXTSEQ_KEY: &[u8] = b"number.v3.nextseq.parent";

/// Secret-store key holding the payments `u64` little-endian next-sequence.
pub const PAYMENTS_NEXTSEQ_KEY: &[u8] = b"number.v4.nextseq.payments";

/// Secret-store key holding the v5 adjustments `u64` little-endian counter.
/// Dormant in pass 1; included in export/import so pass 2 needs no migration.
pub const ADJUSTMENTS_NEXTSEQ_KEY: &[u8] = b"number.v5.nextseq.adjustments";

/// Secret-store key holding the v8 auto-advance configuration.
pub const CONFIG_KEY: &[u8] = b"number.v8.config";
/// Secret-store key holding the append-only subscription set.
pub const SUBSCRIPTIONS_KEY: &[u8] = b"number.v8.subscriptions";
/// Secret-store key holding the scan/inbox state machine.
pub const INBOX_KEY: &[u8] = b"number.v8.inbox";
/// Secret-store key holding the bounded dedup map.
pub const DEDUP_KEY: &[u8] = b"number.v8.dedup";
/// Secret-store key holding the bounded audit log.
pub const AUDIT_KEY: &[u8] = b"number.v8.audit";

/// Bootstrap at most this many subscribes per invocation.
pub const MAX_BOOTSTRAP_SUBSCRIBES: usize = 4;
/// Network operations allowed per parked run (node start or wake-up).
pub const MAX_NETWORK_OPS: u8 = 4;
/// Bounded audit log length.
pub const MAX_AUDIT_ENTRIES: usize = 32;
/// Bounded dedup map length.
pub const MAX_DEDUP_ENTRIES: usize = 64;
/// Default per-payment cap in hundredths (10,000.00); `0` disables the cap.
pub const DEFAULT_MAX_AMOUNT: i64 = 1_000_000;
/// Maximum v5 adjustment log length.
pub const MAX_ADJUSTMENTS: usize = 32;
/// Maximum adjustment note length in UTF-8 bytes.
pub const MAX_ADJUSTMENT_NOTE_BYTES: usize = 128;

/// Domain separator for the canonical slot signing bytes (`DESIGN.md` §2).
/// Unchanged from v2 so v2 signatures keep validating.
const SIGNING_DOMAIN_SLOT: &[u8] = b"number:v2:slot";

/// Domain separator for the canonical contacts signing bytes (`DESIGN.md` §2).
/// Unchanged from v2.
const SIGNING_DOMAIN_CONTACTS: &[u8] = b"number:v2:contacts";

/// Domain separator for the canonical parent signing bytes (`DESIGN.md` §2).
const SIGNING_DOMAIN_PARENT: &[u8] = b"number:v3:parent";

/// Domain separator for the canonical payments signing bytes
/// (`DESIGN-payments.md`).
const SIGNING_DOMAIN_PAYMENTS: &[u8] = b"number:v4:payments";

/// Domain separator for the v5 adjustments signing bytes (pass 2).
const SIGNING_DOMAIN_ADJUSTMENTS: &[u8] = b"number:v5:adjustments";

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

/// Whether `value` is exactly 64 lowercase hexadecimal characters (32 bytes).
fn is_user_id(value: &str) -> bool {
    is_lower_hex(value, USER_ID_HEX_LEN)
}

/// Whether `value` is exactly `len` lowercase hexadecimal characters.
fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One address-book entry, mirroring the contract's wire shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub label: String,
    #[serde(rename = "userId")]
    pub user_id: String,
}

/// An optional string field. `null` and absent are equivalent on the wire; the
/// canonical signing bytes encode both as length `0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// A count of hundredths ("cents"). Any i64 is valid; absent defaults to 0.
    #[serde(default)]
    pub value: i64,
    /// The contact's stable `userId` (64 lowercase hex chars). Mandatory.
    pub contact: String,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl Entry {
    fn metadata_error(&self) -> Option<String> {
        if !is_user_id(&self.contact) {
            return Some(format!(
                "contact must be exactly {USER_ID_HEX_LEN} lowercase hex characters"
            ));
        }
        check_len("unit", self.unit.as_deref(), MAX_UNIT_BYTES)
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

/// Validate a contact list exactly as the contract does.
fn contacts_error(entries: &[Contact]) -> Option<String> {
    if entries.len() > MAX_CONTACTS {
        return Some(format!(
            "contacts has {} entries; maximum is {MAX_CONTACTS}",
            entries.len()
        ));
    }
    for (index, contact) in entries.iter().enumerate() {
        if contact.label.is_empty() {
            return Some(format!("contact {index} label must not be empty"));
        }
        if contact.label.len() > MAX_CONTACT_LABEL_BYTES {
            return Some(format!(
                "contact {index} label is {} bytes; maximum is {MAX_CONTACT_LABEL_BYTES}",
                contact.label.len()
            ));
        }
        if !is_user_id(&contact.user_id) {
            return Some(format!(
                "contact {index} userId must be exactly {USER_ID_HEX_LEN} lowercase hex characters"
            ));
        }
        let earlier = &entries[..index];
        if earlier.iter().any(|other| other.user_id == contact.user_id) {
            return Some(format!("contact {index} duplicates a userId"));
        }
        if earlier.iter().any(|other| other.label == contact.label) {
            return Some(format!("contact {index} duplicates a label"));
        }
    }
    None
}

/// Maximum digits in a payment address (`DESIGN-payments.md`).
pub const MAX_ADDRESS_DIGITS: usize = 32;
/// Maximum legs in a payment (the LCA has two).
pub const MAX_PAYMENT_LEGS: usize = 2;
/// Maximum settled payment ids retained in a `payments` record.
pub const MAX_SETTLED_PAYMENTS: usize = 8;
/// Maximum route cursor; `N = dS + dD` is bounded by the address depth.
pub const MAX_PAYMENT_CURSOR: u8 = 64;

/// One applied payment leg: the slot write an actor signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentLeg {
    pub slot: u8,
    pub seq: u64,
    #[serde(rename = "postValue")]
    pub post_value: i64,
    /// The slot signature (128 lowercase hex characters).
    pub sig: String,
}

/// The single active payment carried in a board's `payments` record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payment {
    /// `blake3(src || srcSeq || dst || amount)[0..16]` hex.
    pub id: String,
    pub src: String,
    pub dst: String,
    pub amount: i64,
    #[serde(rename = "srcAddr")]
    pub src_addr: String,
    #[serde(rename = "dstAddr")]
    pub dst_addr: String,
    pub cursor: u8,
    pub phase: String,
    pub status: String,
    pub next: String,
    #[serde(default)]
    pub fail: Option<String>,
    pub legs: Vec<PaymentLeg>,
}

/// The `payments` record: a sequence, its settled ids, an optional entry and
/// its signature.
///
/// `seq == 0` is the empty record; `seq > 0` with no entry is a legal
/// tombstone. Tombstones may still carry settled ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payments {
    pub seq: u64,
    /// Recently settled payment ids, oldest first (at most
    /// [`MAX_SETTLED_PAYMENTS`]).
    #[serde(default)]
    pub settled: Vec<String>,
    pub entry: Option<Payment>,
    pub sig: Option<String>,
}

/// One v5 issue/burn log entry (pass 2; signing is dormant in pass 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Adjustment {
    /// `0..=7`.
    pub slot: u8,
    /// The slot write this adjustment describes; `> 0`.
    #[serde(rename = "slotSeq")]
    pub slot_seq: u64,
    /// `+issue`, `-burn`, non-zero.
    pub delta: i64,
    /// Signed post-value; `>= 0`.
    #[serde(rename = "postValue")]
    pub post_value: i64,
    #[serde(default)]
    pub note: Option<String>,
}

/// Validate the structural bounds shared by the delegate and the v5 contract.
fn adjustments_error(entries: &[Adjustment]) -> Option<String> {
    if entries.len() > MAX_ADJUSTMENTS {
        return Some(format!(
            "adjustments has {} entries; maximum is {MAX_ADJUSTMENTS}",
            entries.len()
        ));
    }
    let mut previous: Vec<(u8, u64)> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        if usize::from(entry.slot) >= SLOT_COUNT {
            return Some(format!("adjustment {index} slot is out of range"));
        }
        if entry.slot_seq == 0 {
            return Some(format!("adjustment {index} slotSeq must be greater than 0"));
        }
        if entry.delta == 0 {
            return Some(format!("adjustment {index} delta must be non-zero"));
        }
        if entry.post_value < 0 {
            return Some(format!("adjustment {index} postValue must not be negative"));
        }
        if entry
            .post_value
            .checked_sub(entry.delta)
            .is_none_or(|pre| pre < 0)
        {
            return Some(format!(
                "adjustment {index} pre-value must be non-negative and not overflow"
            ));
        }
        if entry
            .note
            .as_deref()
            .is_some_and(|note| note.len() > MAX_ADJUSTMENT_NOTE_BYTES)
        {
            return Some(format!(
                "adjustment {index} note is larger than {MAX_ADJUSTMENT_NOTE_BYTES} bytes"
            ));
        }
        if previous.contains(&(entry.slot, entry.slot_seq)) {
            return Some(format!(
                "adjustment {index} duplicates an earlier (slot, slotSeq)"
            ));
        }
        if let Some(last) = previous.iter().rev().find(|other| other.0 == entry.slot) {
            if entry.slot_seq <= last.1 {
                return Some(format!(
                    "adjustment {index} slotSeq must increase within a slot"
                ));
            }
        }
        previous.push((entry.slot, entry.slot_seq));
    }
    None
}

/// Auto-advance configuration stored in [`CONFIG_KEY`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegateConfig {
    /// Base58 32-byte code hashes, newest first.
    #[serde(rename = "codeHashes")]
    pub code_hashes: Vec<String>,
    /// The owner's octal address.
    pub address: String,
    /// Whether auto-advance is enabled.
    #[serde(rename = "autoAdvance")]
    pub auto_advance: bool,
    /// Per-payment cap in hundredths; `0` disables the cap.
    #[serde(rename = "maxAmount")]
    pub max_amount: i64,
}

/// Persisted subscription set. `subscribed` is append-only; core#5600 means we
/// never unsubscribe. `pending` holds ids awaiting a response.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SubscriptionState {
    #[serde(default)]
    pub subscribed: Vec<String>,
    #[serde(default)]
    pub pending: Vec<String>,
}

/// Per-instance scan state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceRecord {
    /// `unknown` | `requested` | `known`.
    pub state: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub owner: Option<String>,
    /// Hex-encoded raw state bytes, when known.
    #[serde(default)]
    pub data: Option<String>,
    /// A `None` GET response is ambiguous (refusal, NotFound, unreachable).
    /// Retry on the next wake, not within the same response pass.
    #[serde(rename = "retryNextWake", default)]
    pub retry_next_wake: bool,
}

/// Persisted inbox/scan state.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct InboxState {
    #[serde(default)]
    pub instances: std::collections::BTreeMap<String, InstanceRecord>,
    #[serde(default)]
    pub cursor: usize,
    #[serde(rename = "budgetReset", default)]
    pub budget_reset: String,
    #[serde(default)]
    pub budget: u8,
    /// Number of scan passes performed (the status `lastScan`).
    #[serde(rename = "lastScan", default)]
    pub last_scan: u64,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    /// Newest configured hash that resolved the own board.
    #[serde(rename = "matchedCodeHash", default)]
    pub matched_code_hash: Option<String>,
}

/// Bounded dedup map, keyed by `(payment_id, cursor, phase, from_owner)`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DedupState {
    #[serde(default)]
    pub keys: Vec<String>,
}

/// One audit entry (last [`MAX_AUDIT_ENTRIES`] retained).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub cursor: u8,
    pub slots: Vec<u8>,
    pub role: String,
}

/// Bounded audit log.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AuditState {
    #[serde(default)]
    pub entries: Vec<AuditEntry>,
}

fn is_address(value: &str) -> bool {
    value.len() <= MAX_ADDRESS_DIGITS && value.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
}

fn is_all_zero_user_id(value: &str) -> bool {
    value.len() == USER_ID_HEX_LEN && value.bytes().all(|byte| byte == b'0')
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

fn fail_tag(value: &str) -> Option<u8> {
    match value {
        "negative" => Some(1),
        "no-destination" => Some(2),
        "busy" => Some(3),
        "refused" => Some(4),
        "address-mismatch" => Some(5),
        "blocked" => Some(6),
        "superseded" => Some(7),
        _ => None,
    }
}

/// Validate the bounded settled-id list exactly as the v4 contract does.
fn settled_error(settled: &[String]) -> Option<String> {
    if settled.len() > MAX_SETTLED_PAYMENTS {
        return Some(format!(
            "payments settled has {} ids; maximum is {MAX_SETTLED_PAYMENTS}",
            settled.len()
        ));
    }
    for (index, id) in settled.iter().enumerate() {
        if !is_lower_hex(id, 32) {
            return Some(format!(
                "payments settled id {index} must be exactly 32 lowercase hex characters"
            ));
        }
        if settled[..index].iter().any(|other| other == id) {
            return Some(format!(
                "payments settled id {index} duplicates an earlier id"
            ));
        }
    }
    None
}

/// Validate a payment entry exactly as the v4 contract does.
///
/// The contract deliberately does not check tree topology, the LCA or the
/// amount arithmetic; those are UI protocol rules.
fn payment_error(payment: &Payment) -> Option<String> {
    if !is_lower_hex(&payment.id, 32) {
        return Some("payment id must be exactly 32 lowercase hex characters".into());
    }
    for (field, value) in [("src", &payment.src), ("dst", &payment.dst)] {
        if !is_user_id(value) {
            return Some(format!(
                "payment {field} must be exactly {USER_ID_HEX_LEN} lowercase hex characters"
            ));
        }
    }
    if payment.amount <= 0 {
        return Some("payment amount must be greater than 0".into());
    }
    for (field, value) in [
        ("srcAddr", &payment.src_addr),
        ("dstAddr", &payment.dst_addr),
    ] {
        if !is_address(value) {
            return Some(format!(
                "payment {field} must be at most {MAX_ADDRESS_DIGITS} octal digits 0..7"
            ));
        }
    }
    if payment.cursor > MAX_PAYMENT_CURSOR {
        return Some(format!(
            "payment cursor must be at most {MAX_PAYMENT_CURSOR}"
        ));
    }
    if phase_tag(&payment.phase).is_none() {
        return Some("payment phase must be forward, reverse or terminal".into());
    }
    if status_tag(&payment.status).is_none() {
        return Some(format!(
            "payment status {:?} is not recognised",
            payment.status
        ));
    }
    if payment
        .fail
        .as_deref()
        .is_some_and(|fail| fail_tag(fail).is_none())
    {
        return Some(format!(
            "payment fail {:?} is not recognised",
            payment.fail.as_deref().unwrap_or_default()
        ));
    }
    if !is_user_id(&payment.next) {
        return Some(format!(
            "payment next must be exactly {USER_ID_HEX_LEN} lowercase hex characters"
        ));
    }
    if payment.phase == "terminal" && !is_all_zero_user_id(&payment.next) {
        return Some("payment next must be all zero when phase is terminal".into());
    }
    // Mirror the contract's conservative phase/status coherence.
    match payment.status.as_str() {
        "offered" if payment.cursor != 0 || !payment.legs.is_empty() => {
            return Some("payment status offered requires cursor 0 and no legs".into());
        }
        "complete" | "reversed" | "blocked" if payment.phase != "terminal" => {
            return Some(format!(
                "payment status {} requires terminal phase",
                payment.status
            ));
        }
        _ => {}
    }
    if payment.legs.len() > MAX_PAYMENT_LEGS {
        return Some(format!(
            "payment has {} legs; maximum is {MAX_PAYMENT_LEGS}",
            payment.legs.len()
        ));
    }
    for (index, leg) in payment.legs.iter().enumerate() {
        if usize::from(leg.slot) >= SLOT_COUNT {
            return Some(format!(
                "payment leg {index} slot {} is out of range; must be 0..{}",
                leg.slot,
                SLOT_COUNT - 1
            ));
        }
        if payment.legs[..index]
            .iter()
            .any(|other| other.slot == leg.slot)
        {
            return Some(format!("payment leg {index} duplicates slot {}", leg.slot));
        }
        if leg.seq == 0 {
            return Some(format!("payment leg {index} seq must be greater than 0"));
        }
        if !is_lower_hex(&leg.sig, 128) {
            return Some(format!(
                "payment leg {index} sig must be exactly 128 lowercase hex characters"
            ));
        }
    }
    None
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
    /// Sign a whole address-book record at `seq`.
    #[serde(rename = "signContacts")]
    SignContacts {
        seq: u64,
        entries: Vec<Contact>,
    },
    /// Sign the parent record at `seq`; `userId` null clears the parent.
    #[serde(rename = "signParent")]
    SignParent {
        seq: u64,
        #[serde(rename = "userId")]
        user_id: Option<String>,
    },
    /// Sign the payments record at `seq`; a null entry is a legal tombstone.
    #[serde(rename = "signPayments")]
    SignPayments {
        seq: u64,
        #[serde(default)]
        settled: Vec<String>,
        #[serde(default)]
        entry: Option<Payment>,
    },
    /// Persist the auto-advance configuration.
    Configure {
        #[serde(rename = "codeHashes")]
        code_hashes: Vec<String>,
        address: String,
        #[serde(rename = "autoAdvance", default = "default_auto_advance")]
        auto_advance: bool,
        #[serde(rename = "maxAmount", default = "default_max_amount")]
        max_amount: i64,
    },
    /// Enable/disable auto-advance; optionally change the cap.
    #[serde(rename = "setAutoAdvance")]
    SetAutoAdvance {
        enabled: bool,
        #[serde(rename = "maxAmount", default)]
        max_amount: Option<i64>,
    },
    /// Sign a v5 adjustments record (dormant in pass 1).
    #[serde(rename = "signAdjustment")]
    SignAdjustment {
        seq: u64,
        entries: Vec<Adjustment>,
    },
    /// Report whether this delegate has already created a seed, without
    /// creating one. The UI uses this before attempting a migration.
    Status,
    /// Return the owner seed and counters for a successor delegate.
    /// Only the pinned webapp may ask; this is the forward-only migration path.
    Export,
    /// Restore an exported seed into a fresh delegate. Refused once a seed
    /// exists, so a later request cannot overwrite the owner identity.
    Import {
        seed: String,
        #[serde(rename = "nextSeq")]
        next_seq: Vec<u64>,
        #[serde(rename = "contactsNextSeq", default = "default_contacts_next_seq")]
        contacts_next_seq: u64,
        #[serde(rename = "parentNextSeq", default = "default_parent_next_seq")]
        parent_next_seq: u64,
        #[serde(rename = "paymentsNextSeq", default = "default_payments_next_seq")]
        payments_next_seq: u64,
        #[serde(
            rename = "adjustmentsNextSeq",
            default = "default_adjustments_next_seq"
        )]
        adjustments_next_seq: u64,
    },
}

fn default_contacts_next_seq() -> u64 {
    1
}

fn default_parent_next_seq() -> u64 {
    1
}

fn default_payments_next_seq() -> u64 {
    1
}

fn default_adjustments_next_seq() -> u64 {
    1
}

fn default_auto_advance() -> bool {
    true
}

fn default_max_amount() -> i64 {
    DEFAULT_MAX_AMOUNT
}

/// `{"ok":true,"pubkey":"<64 hex>","nextSeq":[...],"contactsNextSeq":1,"parentNextSeq":1,"paymentsNextSeq":1}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityResponse {
    pub ok: bool,
    pub pubkey: String,
    #[serde(rename = "nextSeq")]
    pub next_seq: [u64; SLOT_COUNT],
    #[serde(rename = "contactsNextSeq")]
    pub contacts_next_seq: u64,
    #[serde(rename = "parentNextSeq")]
    pub parent_next_seq: u64,
    #[serde(rename = "paymentsNextSeq")]
    pub payments_next_seq: u64,
    #[serde(rename = "adjustmentsNextSeq")]
    pub adjustments_next_seq: u64,
}

/// `{"ok":true,"seq":N,"sig":"<128 hex>"}` for a v5 adjustment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdjustmentResponse {
    pub ok: bool,
    pub seq: u64,
    pub sig: String,
}

/// `{"ok":true,"sig":"<128 hex>"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignResponse {
    pub ok: bool,
    pub sig: String,
}

/// `{"ok":true,"hasSeed":false}` before first use, or
/// `{"ok":true,"hasSeed":true,"pubkey":"<64 hex>","nextSeq":[...],"contactsNextSeq":1,"parentNextSeq":1,"paymentsNextSeq":1}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusResponse {
    pub ok: bool,
    pub version: u32,
    #[serde(rename = "hasSeed")]
    pub has_seed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
    #[serde(rename = "nextSeq", skip_serializing_if = "Option::is_none")]
    pub next_seq: Option<[u64; SLOT_COUNT]>,
    #[serde(rename = "contactsNextSeq", skip_serializing_if = "Option::is_none")]
    pub contacts_next_seq: Option<u64>,
    #[serde(rename = "parentNextSeq", skip_serializing_if = "Option::is_none")]
    pub parent_next_seq: Option<u64>,
    #[serde(rename = "paymentsNextSeq", skip_serializing_if = "Option::is_none")]
    pub payments_next_seq: Option<u64>,
    #[serde(rename = "adjustmentsNextSeq", skip_serializing_if = "Option::is_none")]
    pub adjustments_next_seq: Option<u64>,
    /// Whether a valid auto-advance configuration exists.
    pub configured: bool,
    /// Empty until configured. Always present on a v8 response.
    #[serde(rename = "codeHashes")]
    pub code_hashes: Vec<String>,
    /// `null` until a scan resolves the own instance.
    #[serde(rename = "matchedCodeHash")]
    pub matched_code_hash: Option<String>,
    /// Empty until configured.
    pub address: String,
    /// Default-on even before `configure`.
    #[serde(rename = "autoAdvance")]
    pub auto_advance: bool,
    /// Defaults to 1,000,000 even before `configure`.
    #[serde(rename = "maxAmount")]
    pub max_amount: i64,
    #[serde(default)]
    pub subscriptions: Vec<String>,
    #[serde(rename = "lastScan")]
    pub last_scan: u64,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub audit: Vec<AuditEntry>,
}

/// `{"ok":true,"seed":"<64 hex>","nextSeq":[...],"contactsNextSeq":1,"parentNextSeq":1,"paymentsNextSeq":1}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportResponse {
    pub ok: bool,
    pub version: u32,
    pub seed: String,
    #[serde(rename = "nextSeq")]
    pub next_seq: [u64; SLOT_COUNT],
    #[serde(rename = "contactsNextSeq")]
    pub contacts_next_seq: u64,
    #[serde(rename = "parentNextSeq")]
    pub parent_next_seq: u64,
    #[serde(rename = "paymentsNextSeq")]
    pub payments_next_seq: u64,
    #[serde(rename = "adjustmentsNextSeq")]
    pub adjustments_next_seq: u64,
}

/// `{"ok":true}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportResponse {
    pub ok: bool,
}

/// Bare `{"ok":true}` acknowledgement, used by commands whose result is a
/// side effect (configure/setAutoAdvance) to avoid correlating the reply with
/// an in-flight `status` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
}

/// `{"ok":false,"error":"..."}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub error: String,
}

/// The delegate's JSON response. Untagged because the shapes are
/// discriminated by their fields, exactly as shown in `DESIGN.md` §7.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Response {
    Identity(IdentityResponse),
    Sign(SignResponse),
    Adjustment(AdjustmentResponse),
    Status(Box<StatusResponse>),
    Export(ExportResponse),
    Import(ImportResponse),
    Ok(OkResponse),
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

/// Host access needed by the scan state machine: persistent secrets plus a
/// synchronous local contract read. Production wraps [`DelegateCtx`]; tests
/// can implement it over an in-memory map.
pub trait ContractHost: SecretStore {
    fn local_state(&self, instance: &[u8; 32]) -> Option<Vec<u8>>;
}

/// Production adapter over the host context.
struct CtxHost<'a> {
    ctx: &'a mut DelegateCtx,
}

impl SecretStore for CtxHost<'_> {
    fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>> {
        DelegateCtx::get_secret(self.ctx, key)
    }

    fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool {
        DelegateCtx::set_secret(self.ctx, key, value)
    }
}

impl ContractHost for CtxHost<'_> {
    fn local_state(&self, instance: &[u8; 32]) -> Option<Vec<u8>> {
        self.ctx.get_contract_state(instance)
    }
}

/// The delegate implementation. Stateless: everything persistent is in the
/// secret store, everything temporary is per-call.
pub struct NumberDelegate;

#[delegate(manifest(
    lifecycle = [NodeStarted],
    capabilities = [Background],
    wakeups = [inbox = 300],
))]
impl DelegateInterface for NumberDelegate {
    fn process(
        ctx: &mut DelegateCtx,
        parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
        // The params pin this delegate to one web container contract. Missing
        // or malformed params fail closed rather than falling back to "any
        // web app", which would restore the original signing hole.
        let pinned_webapp = expected_webapp(&parameters).map_err(DelegateError::Other)?;

        match message {
            InboundDelegateMsg::ApplicationMessage(message) => {
                // The single authorization boundary: every application request
                // goes through `handle_application_message`, which refuses a
                // caller other than the pinned web app before dispatching on
                // `cmd`.
                let payload = handle_application_message(
                    ctx,
                    pinned_webapp,
                    origin.as_ref(),
                    &message.payload,
                );
                Ok(vec![OutboundDelegateMsg::ApplicationMessage(
                    ApplicationMessage::new(payload),
                )])
            }
            other => {
                // Background runs: lifecycle, wake-ups, contract notifications
                // and every request/response that resumes the scan.
                let mut host = CtxHost { ctx };
                Ok(handle_background(&mut host, other))
            }
        }
    }
}

/// Decode the pinned webapp contract id from the delegate parameters.
///
/// The parameters must be exactly the 32 raw bytes of the web container
/// contract's instance id. Anything else is a configuration error and fails
/// closed: an unpinned delegate would again sign for any web app.
pub fn expected_webapp(params: &Parameters<'_>) -> Result<ContractInstanceId, String> {
    let bytes: [u8; WEBAPP_ID_LEN] = params.as_ref().try_into().map_err(|_| {
        format!(
            "delegate parameters must be the {WEBAPP_ID_LEN}-byte webapp contract id, got {} bytes",
            params.as_ref().len()
        )
    })?;
    Ok(ContractInstanceId::new(bytes))
}

/// Authorize a caller.
///
/// This delegate custodies a private key, so only the pinned web container
/// contract may use it. Inter-delegate calls name the calling delegate, not
/// the person, and an unattested call has no caller at all. New
/// `MessageOrigin` variants fail closed through the wildcard arm.
pub fn authorize(
    expected_webapp: ContractInstanceId,
    origin: Option<&MessageOrigin>,
) -> Result<(), String> {
    match origin {
        Some(MessageOrigin::WebApp(id)) if *id == expected_webapp => Ok(()),
        Some(MessageOrigin::WebApp(id)) => Err(format!(
            "refused web app {id}: number-delegate only serves {expected_webapp}"
        )),
        Some(MessageOrigin::Delegate(caller)) => Err(format!(
            "refused inter-delegate call from {caller:?}: number-delegate only serves the pinned web app"
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
    expected_webapp: ContractInstanceId,
    origin: Option<&MessageOrigin>,
    payload: &[u8],
) -> Vec<u8> {
    let response = match authorize(expected_webapp, origin) {
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
            Ok((
                pubkey,
                next_seq,
                contacts_next_seq,
                parent_next_seq,
                payments_next_seq,
                adjustments_next_seq,
            )) => Response::Identity(IdentityResponse {
                ok: true,
                pubkey,
                next_seq,
                contacts_next_seq,
                parent_next_seq,
                payments_next_seq,
                adjustments_next_seq,
            }),
            Err(error) => Response::error(error),
        },
        Request::Sign { slot, seq, entry } => match sign_with(store, slot, seq, entry.as_ref()) {
            Ok(sig) => Response::Sign(SignResponse { ok: true, sig }),
            Err(error) => Response::error(error),
        },
        Request::SignContacts { seq, entries } => match sign_contacts_with(store, seq, &entries) {
            Ok(sig) => Response::Sign(SignResponse { ok: true, sig }),
            Err(error) => Response::error(error),
        },
        Request::SignParent { seq, user_id } => {
            match sign_parent_with(store, seq, user_id.as_deref()) {
                Ok(sig) => Response::Sign(SignResponse { ok: true, sig }),
                Err(error) => Response::error(error),
            }
        }
        Request::SignPayments {
            seq,
            settled,
            entry,
        } => match sign_payments_with(store, seq, &settled, entry.as_ref()) {
            Ok(sig) => Response::Sign(SignResponse { ok: true, sig }),
            Err(error) => Response::error(error),
        },
        Request::SignAdjustment { seq, entries } => {
            match sign_adjustment_with(store, seq, &entries) {
                Ok(sig) => Response::Adjustment(AdjustmentResponse { ok: true, seq, sig }),
                Err(error) => Response::error(error),
            }
        }
        Request::Configure {
            code_hashes,
            address,
            auto_advance,
            max_amount,
        } => match configure_with(store, &code_hashes, &address, auto_advance, max_amount) {
            Ok(()) => Response::Ok(OkResponse { ok: true }),
            Err(error) => Response::error(error),
        },
        Request::SetAutoAdvance {
            enabled,
            max_amount,
        } => match set_auto_advance_with(store, enabled, max_amount) {
            Ok(()) => Response::Ok(OkResponse { ok: true }),
            Err(error) => Response::error(error),
        },
        Request::Status => match status_with(store) {
            Ok(response) => Response::Status(Box::new(response)),
            Err(error) => Response::error(error),
        },
        Request::Export => match export_with(store) {
            Ok((
                seed,
                next_seq,
                contacts_next_seq,
                parent_next_seq,
                payments_next_seq,
                adjustments_next_seq,
            )) => Response::Export(ExportResponse {
                ok: true,
                version: DELEGATE_VERSION,
                seed,
                next_seq,
                contacts_next_seq,
                parent_next_seq,
                payments_next_seq,
                adjustments_next_seq,
            }),
            Err(error) => Response::error(error),
        },
        Request::Import {
            seed,
            next_seq,
            contacts_next_seq,
            parent_next_seq,
            payments_next_seq,
            adjustments_next_seq,
        } => match import_with(
            store,
            &seed,
            &next_seq,
            contacts_next_seq,
            parent_next_seq,
            payments_next_seq,
            adjustments_next_seq,
        ) {
            Ok(()) => Response::Import(ImportResponse { ok: true }),
            Err(error) => Response::error(error),
        },
    }
}

/// Return `(hex public key, nextSeq[0..8], contactsNextSeq, parentNextSeq,
/// paymentsNextSeq)`, creating the seed on first use.
/// `(pubkey hex, nextSeq, contactsNextSeq, parentNextSeq, paymentsNextSeq,
/// adjustmentsNextSeq)`.
pub type OwnerCounters = (String, [u64; SLOT_COUNT], u64, u64, u64, u64);

pub fn identity_with(store: &mut impl SecretStore) -> Result<OwnerCounters, String> {
    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let pubkey = hex::encode(signing_key.verifying_key().to_bytes());

    let mut next_seq = [1u64; SLOT_COUNT];
    for (slot, value) in next_seq.iter_mut().enumerate() {
        *value = read_next_seq(store, slot as u8)?;
    }
    let contacts_next_seq = read_contacts_next_seq(store)?;
    let parent_next_seq = read_parent_next_seq(store)?;
    let payments_next_seq = read_payments_next_seq(store)?;
    let adjustments_next_seq = read_adjustments_next_seq(store)?;

    Ok((
        pubkey,
        next_seq,
        contacts_next_seq,
        parent_next_seq,
        payments_next_seq,
        adjustments_next_seq,
    ))
}

/// Report whether a seed exists, without creating one.
///
/// The UI calls this before `identity` so a fresh delegate can be offered a
/// predecessor's exported seed first. `identity` would otherwise create a new
/// seed and make the migration impossible.
pub fn status_with(store: &impl SecretStore) -> Result<StatusResponse, String> {
    let config = load_config(store)?;
    let inbox = load_inbox(store)?;
    let subscriptions = load_subscriptions(store)?;
    let audit = load_audit(store)?;
    let configured = config.is_some();

    let Some(bytes) = store.get_secret(SECRET_SEED) else {
        return Ok(status_response(
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            configured,
            config.as_ref(),
            &inbox,
            &subscriptions,
            audit,
        ));
    };
    let seed: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        format!(
            "stored seed has invalid length {} (expected 32)",
            bytes.len()
        )
    })?;
    let signing_key = SigningKey::from_bytes(&seed);
    let pubkey = hex::encode(signing_key.verifying_key().to_bytes());

    let mut next_seq = [1u64; SLOT_COUNT];
    for (slot, value) in next_seq.iter_mut().enumerate() {
        *value = read_next_seq(store, slot as u8)?;
    }
    let contacts_next_seq = read_contacts_next_seq(store)?;
    let parent_next_seq = read_parent_next_seq(store)?;
    let payments_next_seq = read_payments_next_seq(store)?;
    let adjustments_next_seq = read_adjustments_next_seq(store)?;

    Ok(status_response(
        true,
        Some(pubkey),
        Some(next_seq),
        Some(contacts_next_seq),
        Some(parent_next_seq),
        Some(payments_next_seq),
        Some(adjustments_next_seq),
        configured,
        config.as_ref(),
        &inbox,
        &subscriptions,
        audit,
    ))
}

#[allow(clippy::too_many_arguments)]
fn status_response(
    has_seed: bool,
    pubkey: Option<String>,
    next_seq: Option<[u64; SLOT_COUNT]>,
    contacts_next_seq: Option<u64>,
    parent_next_seq: Option<u64>,
    payments_next_seq: Option<u64>,
    adjustments_next_seq: Option<u64>,
    configured: bool,
    config: Option<&DelegateConfig>,
    inbox: &InboxState,
    subscriptions: &SubscriptionState,
    audit: AuditState,
) -> StatusResponse {
    StatusResponse {
        ok: true,
        version: DELEGATE_VERSION,
        has_seed,
        pubkey,
        next_seq,
        contacts_next_seq,
        parent_next_seq,
        payments_next_seq,
        adjustments_next_seq,
        configured,
        code_hashes: config
            .map(|config| config.code_hashes.clone())
            .unwrap_or_default(),
        matched_code_hash: inbox.matched_code_hash.clone(),
        address: config
            .map(|config| config.address.clone())
            .unwrap_or_default(),
        auto_advance: config.map(|config| config.auto_advance).unwrap_or(true),
        max_amount: config
            .map(|config| config.max_amount)
            .unwrap_or(DEFAULT_MAX_AMOUNT),
        subscriptions: subscriptions.subscribed.clone(),
        last_scan: inbox.last_scan,
        last_error: inbox.last_error.clone(),
        audit: audit.entries,
    }
}

/// Export the owner seed and counters for a successor delegate.
///
/// Authorization is the same pinned-webapp gate as every other request. This
/// is the forward-only migration path: a successor can only recover from a
/// predecessor whose already-published WASM answers this command.
pub fn export_with(store: &impl SecretStore) -> Result<OwnerCounters, String> {
    let Some(bytes) = store.get_secret(SECRET_SEED) else {
        return Err("refused export: this delegate has no seed yet".into());
    };
    let seed: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        format!(
            "stored seed has invalid length {} (expected 32)",
            bytes.len()
        )
    })?;

    let mut next_seq = [1u64; SLOT_COUNT];
    for (slot, value) in next_seq.iter_mut().enumerate() {
        *value = read_next_seq(store, slot as u8)?;
    }
    let contacts_next_seq = read_contacts_next_seq(store)?;
    let parent_next_seq = read_parent_next_seq(store)?;
    let payments_next_seq = read_payments_next_seq(store)?;
    let adjustments_next_seq = read_adjustments_next_seq(store)?;

    Ok((
        hex::encode(seed),
        next_seq,
        contacts_next_seq,
        parent_next_seq,
        payments_next_seq,
        adjustments_next_seq,
    ))
}

/// Restore an exported seed into a fresh delegate.
///
/// Refused once a seed exists: a later request must not silently replace the
/// owner identity. Counters are written first, so a failure to write the seed
/// leaves no half-initialized identity behind and the import can be retried.
pub fn import_with(
    store: &mut impl SecretStore,
    seed_hex: &str,
    next_seq: &[u64],
    contacts_next_seq: u64,
    parent_next_seq: u64,
    payments_next_seq: u64,
    adjustments_next_seq: u64,
) -> Result<(), String> {
    if store.get_secret(SECRET_SEED).is_some() {
        return Err("refused import: this delegate already has a seed".into());
    }
    if next_seq.len() != SLOT_COUNT {
        return Err(format!(
            "nextSeq must have {SLOT_COUNT} entries, got {}",
            next_seq.len()
        ));
    }
    if next_seq.contains(&0) {
        return Err("nextSeq entries must be greater than 0".into());
    }
    if contacts_next_seq == 0 {
        return Err("contactsNextSeq must be greater than 0".into());
    }
    if parent_next_seq == 0 {
        return Err("parentNextSeq must be greater than 0".into());
    }
    if payments_next_seq == 0 {
        return Err("paymentsNextSeq must be greater than 0".into());
    }
    if adjustments_next_seq == 0 {
        return Err("adjustmentsNextSeq must be greater than 0".into());
    }

    let seed_bytes =
        hex::decode(seed_hex).map_err(|error| format!("seed is not valid hex: {error}"))?;
    let seed: [u8; 32] = seed_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("seed must be 32 bytes, got {}", seed_bytes.len()))?;

    for (slot, value) in next_seq.iter().enumerate() {
        if !store.set_secret(&next_seq_key(slot as u8), &value.to_le_bytes()) {
            return Err(format!("failed to persist nextSeq for slot {slot}"));
        }
    }
    if !store.set_secret(CONTACTS_NEXTSEQ_KEY, &contacts_next_seq.to_le_bytes()) {
        return Err("failed to persist contactsNextSeq".into());
    }
    if !store.set_secret(PARENT_NEXTSEQ_KEY, &parent_next_seq.to_le_bytes()) {
        return Err("failed to persist parentNextSeq".into());
    }
    if !store.set_secret(PAYMENTS_NEXTSEQ_KEY, &payments_next_seq.to_le_bytes()) {
        return Err("failed to persist paymentsNextSeq".into());
    }
    if !store.set_secret(ADJUSTMENTS_NEXTSEQ_KEY, &adjustments_next_seq.to_le_bytes()) {
        return Err("failed to persist adjustmentsNextSeq".into());
    }
    if !store.set_secret(SECRET_SEED, &seed) {
        return Err("failed to persist imported seed".into());
    }

    Ok(())
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

/// Validate, sign, then advance the contacts sequence counter.
pub fn sign_contacts_with(
    store: &mut impl SecretStore,
    seq: u64,
    entries: &[Contact],
) -> Result<String, String> {
    if seq == 0 {
        return Err("seq must be greater than 0".into());
    }
    let next_seq = read_contacts_next_seq(store)?;
    if seq < next_seq {
        return Err(format!(
            "stale seq {seq} for contacts; need at least {next_seq}"
        ));
    }
    let following = seq
        .checked_add(1)
        .ok_or_else(|| format!("seq {seq} is too large to advance"))?;
    if let Some(error) = contacts_error(entries) {
        return Err(error);
    }

    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(&contacts_signing_bytes(seq, entries));

    if !store.set_secret(CONTACTS_NEXTSEQ_KEY, &following.to_le_bytes()) {
        return Err("failed to persist contactsNextSeq".into());
    }

    Ok(hex::encode(signature.to_bytes()))
}

/// Validate, sign, then advance the parent sequence counter.
pub fn sign_parent_with(
    store: &mut impl SecretStore,
    seq: u64,
    user_id: Option<&str>,
) -> Result<String, String> {
    if seq == 0 {
        return Err("seq must be greater than 0".into());
    }
    let next_seq = read_parent_next_seq(store)?;
    if seq < next_seq {
        return Err(format!(
            "stale seq {seq} for parent; need at least {next_seq}"
        ));
    }
    let following = seq
        .checked_add(1)
        .ok_or_else(|| format!("seq {seq} is too large to advance"))?;
    if user_id.is_some_and(|value| !is_user_id(value)) {
        return Err(format!(
            "parent userId must be exactly {USER_ID_HEX_LEN} lowercase hex characters"
        ));
    }

    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let owner = hex::encode(signing_key.verifying_key().to_bytes());
    if user_id.is_some_and(|value| value == owner.as_str()) {
        return Err("refused self-parent: userId is the delegate's own pubkey".into());
    }
    let signature = signing_key.sign(&parent_signing_bytes(seq, user_id));

    if !store.set_secret(PARENT_NEXTSEQ_KEY, &following.to_le_bytes()) {
        return Err("failed to persist parentNextSeq".into());
    }

    Ok(hex::encode(signature.to_bytes()))
}

/// Validate, sign, then advance the payments sequence counter.
///
/// A `None` entry at `seq > 0` signs the tombstone (tag `0`); tombstones may
/// still carry settled ids. The counter is written only after a successful
/// signature, exactly like the other records.
pub fn sign_payments_with(
    store: &mut impl SecretStore,
    seq: u64,
    settled: &[String],
    entry: Option<&Payment>,
) -> Result<String, String> {
    if seq == 0 {
        return Err("seq must be greater than 0".into());
    }
    let next_seq = read_payments_next_seq(store)?;
    if seq < next_seq {
        return Err(format!(
            "stale seq {seq} for payments; need at least {next_seq}"
        ));
    }
    let following = seq
        .checked_add(1)
        .ok_or_else(|| format!("seq {seq} is too large to advance"))?;
    if let Some(error) = settled_error(settled) {
        return Err(error);
    }
    if let Some(error) = entry.and_then(payment_error) {
        return Err(error);
    }
    let bytes = payments_signing_bytes(seq, settled, entry)?;

    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(&bytes);

    if !store.set_secret(PAYMENTS_NEXTSEQ_KEY, &following.to_le_bytes()) {
        return Err("failed to persist paymentsNextSeq".into());
    }

    Ok(hex::encode(signature.to_bytes()))
}

/// Validate and sign a v5 adjustments record at `seq` (pass 2, dormant here).
///
/// Requires `seq >= adjustmentsNextSeq`, persists `seq + 1` only after a
/// successful signature, and returns the signature.
pub fn sign_adjustment_with(
    store: &mut impl SecretStore,
    seq: u64,
    entries: &[Adjustment],
) -> Result<String, String> {
    if seq == 0 {
        return Err("seq must be greater than 0".into());
    }
    let next_seq = read_adjustments_next_seq(store)?;
    if seq < next_seq {
        return Err(format!(
            "stale seq {seq} for adjustments; need at least {next_seq}"
        ));
    }
    let following = seq
        .checked_add(1)
        .ok_or_else(|| format!("seq {seq} is too large to advance"))?;
    if let Some(error) = adjustments_error(entries) {
        return Err(error);
    }

    let seed = load_or_create_seed(store)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(&adjustments_signing_bytes(seq, entries));

    if !store.set_secret(ADJUSTMENTS_NEXTSEQ_KEY, &following.to_le_bytes()) {
        return Err("failed to persist adjustmentsNextSeq".into());
    }

    Ok(hex::encode(signature.to_bytes()))
}

/// Build the canonical v5 adjustments signing bytes (`DESIGN-v4.1-v5.md`).
pub fn adjustments_signing_bytes(seq: u64, entries: &[Adjustment]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(64 + entries.len() * 40);
    bytes.extend_from_slice(SIGNING_DOMAIN_ADJUSTMENTS);
    bytes.extend_from_slice(&seq.to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        bytes.push(entry.slot);
        bytes.extend_from_slice(&entry.slot_seq.to_le_bytes());
        bytes.extend_from_slice(&entry.delta.to_le_bytes());
        bytes.extend_from_slice(&entry.post_value.to_le_bytes());
        let note = entry.note.as_deref().unwrap_or("").as_bytes();
        bytes.extend_from_slice(&(note.len() as u32).to_le_bytes());
        bytes.extend_from_slice(note);
    }
    bytes
}

/// Build the canonical slot signing bytes from `DESIGN.md` §2.
///
/// This is the single implementation of the format inside this crate; the
/// contract crate must build byte-identical input. Null and absent optional
/// strings both encode as length 0.
pub fn signing_bytes(slot: u8, seq: u64, entry: Option<&Entry>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(160);
    bytes.extend_from_slice(SIGNING_DOMAIN_SLOT);
    bytes.push(slot);
    bytes.extend_from_slice(&seq.to_le_bytes());

    match entry {
        None => bytes.push(0),
        Some(entry) => {
            bytes.push(1);
            bytes.extend_from_slice(&entry.value.to_le_bytes());
            bytes.extend_from_slice(&contact_raw(&entry.contact));
            push_optional_str(&mut bytes, entry.unit.as_deref());
            push_optional_str(&mut bytes, entry.note.as_deref());
        }
    }

    bytes
}

/// Build the canonical contacts signing bytes from `DESIGN.md` §2.
pub fn contacts_signing_bytes(seq: u64, entries: &[Contact]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(128);
    bytes.extend_from_slice(SIGNING_DOMAIN_CONTACTS);
    bytes.extend_from_slice(&seq.to_le_bytes());
    let count = u32::try_from(entries.len()).expect("contact count is bounded by MAX_CONTACTS");
    bytes.extend_from_slice(&count.to_le_bytes());
    for contact in entries {
        let label = contact.label.as_bytes();
        let label_len =
            u32::try_from(label.len()).expect("label bounds keep lengths below u32::MAX");
        bytes.extend_from_slice(&label_len.to_le_bytes());
        bytes.extend_from_slice(label);
        bytes.extend_from_slice(&contact_raw(&contact.user_id));
    }
    bytes
}

/// Build the canonical parent signing bytes from `DESIGN.md` §2.
///
/// ```text
/// b"number:v3:parent" || seq u64 LE || tag u8
/// // only when tag == 1:
/// || userId 32 raw bytes
/// ```
pub fn parent_signing_bytes(seq: u64, user_id: Option<&str>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(64);
    bytes.extend_from_slice(SIGNING_DOMAIN_PARENT);
    bytes.extend_from_slice(&seq.to_le_bytes());
    match user_id {
        None => bytes.push(0),
        Some(user_id) => {
            bytes.push(1);
            bytes.extend_from_slice(&contact_raw(user_id));
        }
    }
    bytes
}

/// Build the canonical payments signing bytes from `DESIGN-payments.md`.
///
/// ```text
/// b"number:v4:payments" || seq u64 LE || settled_count u8
/// || { settled id 16 raw }
/// || tag u8
/// // only when tag == 1:
/// || id 16 raw || src 32 raw || dst 32 raw || amount i64 LE
/// || srcAddr len u32 LE || srcAddr ASCII
/// || dstAddr len u32 LE || dstAddr ASCII
/// || cursor u8 || phase u8 || status u8 || fail u8 || next 32 raw
/// || legs count u8 || { slot u8 || seq u64 LE || postValue i64 LE || sig 64 raw }
/// ```
///
/// Unlike the optional-string helpers above, malformed hex is an error rather
/// than silently encoded as zeroes: this record is evidence, not a default.
pub fn payments_signing_bytes(
    seq: u64,
    settled: &[String],
    entry: Option<&Payment>,
) -> Result<Vec<u8>, String> {
    if let Some(error) = settled_error(settled) {
        return Err(error);
    }

    let mut bytes = Vec::with_capacity(384);
    bytes.extend_from_slice(SIGNING_DOMAIN_PAYMENTS);
    bytes.extend_from_slice(&seq.to_le_bytes());
    // Validation bounds the count at `MAX_SETTLED_PAYMENTS`, so the cast is
    // lossless.
    bytes.push(settled.len() as u8);
    for id in settled {
        bytes.extend_from_slice(&hex_bytes::<16>("payments settled id", id)?);
    }

    let Some(payment) = entry else {
        bytes.push(0);
        return Ok(bytes);
    };
    if let Some(error) = payment_error(payment) {
        return Err(error);
    }

    bytes.push(1);
    bytes.extend_from_slice(&hex_bytes::<16>("payment id", &payment.id)?);
    bytes.extend_from_slice(&hex_bytes::<32>("payment src", &payment.src)?);
    bytes.extend_from_slice(&hex_bytes::<32>("payment dst", &payment.dst)?);
    bytes.extend_from_slice(&payment.amount.to_le_bytes());

    for value in [&payment.src_addr, &payment.dst_addr] {
        // Validation bounds the address at 32 bytes, so the cast is lossless.
        bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }

    bytes.push(payment.cursor);
    bytes.push(phase_tag(&payment.phase).ok_or("payment phase is not recognised")?);
    bytes.push(status_tag(&payment.status).ok_or("payment status is not recognised")?);
    bytes.push(match payment.fail.as_deref() {
        None => 0,
        Some(fail) => fail_tag(fail).ok_or("payment fail is not recognised")?,
    });
    bytes.extend_from_slice(&hex_bytes::<32>("payment next", &payment.next)?);

    // Validation bounds the leg count at two.
    bytes.push(payment.legs.len() as u8);
    for leg in &payment.legs {
        bytes.push(leg.slot);
        bytes.extend_from_slice(&leg.seq.to_le_bytes());
        bytes.extend_from_slice(&leg.post_value.to_le_bytes());
        bytes.extend_from_slice(&hex_bytes::<64>("payment leg sig", &leg.sig)?);
    }

    Ok(bytes)
}

/// Decode exactly `N` bytes of lowercase hex. Callers validate the shape first.
fn hex_bytes<const N: usize>(field: &str, value: &str) -> Result<[u8; N], String> {
    let decoded =
        hex::decode(value).map_err(|error| format!("{field} is not valid hex: {error}"))?;
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| format!("{field} must be {N} bytes, got {}", decoded.len()))
}

/// Decode a 64-hex-character user id into its raw 32 bytes. Invalid input maps
/// to all-zero bytes; callers validate before signing.
fn contact_raw(value: &str) -> [u8; 32] {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or([0u8; 32])
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

fn read_contacts_next_seq(store: &impl SecretStore) -> Result<u64, String> {
    match store.get_secret(CONTACTS_NEXTSEQ_KEY) {
        None => Ok(1),
        Some(bytes) => {
            let bytes: [u8; 8] = bytes.as_slice().try_into().map_err(|_| {
                format!(
                    "stored contactsNextSeq has invalid length {} (expected 8)",
                    bytes.len()
                )
            })?;
            Ok(u64::from_le_bytes(bytes))
        }
    }
}

fn read_parent_next_seq(store: &impl SecretStore) -> Result<u64, String> {
    match store.get_secret(PARENT_NEXTSEQ_KEY) {
        None => Ok(1),
        Some(bytes) => {
            let bytes: [u8; 8] = bytes.as_slice().try_into().map_err(|_| {
                format!(
                    "stored parentNextSeq has invalid length {} (expected 8)",
                    bytes.len()
                )
            })?;
            Ok(u64::from_le_bytes(bytes))
        }
    }
}

fn read_payments_next_seq(store: &impl SecretStore) -> Result<u64, String> {
    match store.get_secret(PAYMENTS_NEXTSEQ_KEY) {
        None => Ok(1),
        Some(bytes) => {
            let bytes: [u8; 8] = bytes.as_slice().try_into().map_err(|_| {
                format!(
                    "stored paymentsNextSeq has invalid length {} (expected 8)",
                    bytes.len()
                )
            })?;
            Ok(u64::from_le_bytes(bytes))
        }
    }
}

fn read_adjustments_next_seq(store: &impl SecretStore) -> Result<u64, String> {
    match store.get_secret(ADJUSTMENTS_NEXTSEQ_KEY) {
        None => Ok(1),
        Some(bytes) => {
            let bytes: [u8; 8] = bytes.as_slice().try_into().map_err(|_| {
                format!(
                    "stored adjustmentsNextSeq has invalid length {} (expected 8)",
                    bytes.len()
                )
            })?;
            Ok(u64::from_le_bytes(bytes))
        }
    }
}

fn load_seed(store: &impl SecretStore) -> Result<[u8; 32], String> {
    let Some(bytes) = store.get_secret(SECRET_SEED) else {
        return Err("no seed: call identity first".into());
    };
    bytes.as_slice().try_into().map_err(|_| {
        format!(
            "stored seed has invalid length {} (expected 32)",
            bytes.len()
        )
    })
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

// ---------------------------------------------------------------------------
// v8 configuration, subscriptions and the inbox scan state machine
// ---------------------------------------------------------------------------

fn read_json<T: serde::de::DeserializeOwned>(
    store: &impl SecretStore,
    key: &[u8],
) -> Result<Option<T>, String> {
    let Some(bytes) = store.get_secret(key) else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        format!(
            "stored {} is invalid JSON: {error}",
            String::from_utf8_lossy(key)
        )
    })
}

fn write_json<T: Serialize>(
    store: &mut impl SecretStore,
    key: &[u8],
    value: &T,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode {}: {error}", String::from_utf8_lossy(key)))?;
    if !store.set_secret(key, &bytes) {
        return Err(format!(
            "failed to persist {}",
            String::from_utf8_lossy(key)
        ));
    }
    Ok(())
}

fn load_config(store: &impl SecretStore) -> Result<Option<DelegateConfig>, String> {
    read_json(store, CONFIG_KEY)
}

fn load_subscriptions(store: &impl SecretStore) -> Result<SubscriptionState, String> {
    Ok(read_json(store, SUBSCRIPTIONS_KEY)?.unwrap_or_default())
}

fn load_inbox(store: &impl SecretStore) -> Result<InboxState, String> {
    Ok(read_json(store, INBOX_KEY)?.unwrap_or_default())
}

fn load_dedup(store: &impl SecretStore) -> Result<DedupState, String> {
    Ok(read_json(store, DEDUP_KEY)?.unwrap_or_default())
}

fn load_audit(store: &impl SecretStore) -> Result<AuditState, String> {
    Ok(read_json(store, AUDIT_KEY)?.unwrap_or_default())
}

/// Decode a base58 32-byte code hash. Hex is explicitly rejected.
fn decode_code_hash(value: &str) -> Result<[u8; 32], String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("codeHashes must be base58, not 64-character hex".into());
    }
    let bytes = bs58::decode(value)
        .with_alphabet(bs58::Alphabet::BITCOIN)
        .into_vec()
        .map_err(|error| format!("code hash {value:?} is not valid base58: {error}"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("code hash {value:?} must decode to 32 bytes"))
}

fn decode_hashes(values: &[String]) -> Result<Vec<[u8; 32]>, String> {
    if values.is_empty() {
        return Err("codeHashes must not be empty".into());
    }
    values.iter().map(|value| decode_code_hash(value)).collect()
}

fn owner_key_bytes(owner: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(owner).map_err(|error| format!("owner is not hex: {error}"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("owner must be 32 bytes, got {}", bytes.len()))
}

/// `BLAKE3(raw code hash || raw owner key)`.
pub fn derive_instance_id(code_hash: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(code_hash);
    hasher.update(owner);
    *hasher.finalize().as_bytes()
}

fn instance_candidates(
    hashes: &[[u8; 32]],
    owner: &str,
) -> Result<Vec<(usize, String, [u8; 32])>, String> {
    let owner_bytes = owner_key_bytes(owner)?;
    Ok(hashes
        .iter()
        .enumerate()
        .map(|(index, hash)| {
            let id = derive_instance_id(hash, &owner_bytes);
            (index, hex::encode(hash), id)
        })
        .collect())
}

fn newest_instance(hashes: &[[u8; 32]], owner: &str) -> Result<(String, [u8; 32]), String> {
    let candidates = instance_candidates(hashes, owner)?;
    let (_, hash, id) = candidates
        .into_iter()
        .next()
        .ok_or_else(|| "codeHashes must not be empty".to_string())?;
    Ok((hash, id))
}

/// Persist the configuration from `configure`.
pub fn configure_with(
    store: &mut impl SecretStore,
    code_hashes: &[String],
    address: &str,
    auto_advance: bool,
    max_amount: i64,
) -> Result<(), String> {
    // Configure never mints an identity: the seed must already exist, so the
    // derived instance ids name boards the user already owns.
    let _ = load_seed(store)?;
    let hashes = decode_hashes(code_hashes)?;
    if !is_address(address) {
        return Err(format!(
            "address must be at most {MAX_ADDRESS_DIGITS} octal digits 0..7"
        ));
    }
    if max_amount < 0 {
        return Err("maxAmount must not be negative".into());
    }
    // Reject malformed owner keys early rather than at the first scan.
    let seed = load_seed(store)?;
    let owner = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    for hash in &hashes {
        let _ = derive_instance_id(hash, &owner);
    }

    let config = DelegateConfig {
        code_hashes: code_hashes.to_vec(),
        address: address.to_owned(),
        auto_advance,
        max_amount,
    };
    write_json(store, CONFIG_KEY, &config)?;

    let mut inbox = load_inbox(store)?;
    inbox.matched_code_hash = None;
    inbox.last_error = None;
    write_json(store, INBOX_KEY, &inbox)?;

    Ok(())
}

/// Change auto-advance policy without re-supplying the whole configuration.
pub fn set_auto_advance_with(
    store: &mut impl SecretStore,
    enabled: bool,
    max_amount: Option<i64>,
) -> Result<(), String> {
    let Some(mut config) = load_config(store)? else {
        return Err("not configured: send configure first".into());
    };
    if let Some(max_amount) = max_amount {
        if max_amount < 0 {
            return Err("maxAmount must not be negative".into());
        }
        config.max_amount = max_amount;
    }
    config.auto_advance = enabled;
    write_json(store, CONFIG_KEY, &config)?;
    Ok(())
}

fn dedup_key(payment: &Payment, from_owner: &str) -> String {
    format!(
        "{}:{}:{}:{}",
        payment.id, payment.cursor, payment.phase, from_owner
    )
}

fn dedup_insert(state: &mut DedupState, key: String) {
    state.keys.retain(|existing| existing != &key);
    state.keys.push(key);
    if state.keys.len() > MAX_DEDUP_ENTRIES {
        let excess = state.keys.len() - MAX_DEDUP_ENTRIES;
        state.keys.drain(0..excess);
    }
}

fn dedup_remove(state: &mut DedupState, key: &str) {
    state.keys.retain(|existing| existing != key);
}

fn audit_push(state: &mut AuditState, entry: AuditEntry) {
    state.entries.push(entry);
    if state.entries.len() > MAX_AUDIT_ENTRIES {
        let excess = state.entries.len() - MAX_AUDIT_ENTRIES;
        state.entries.drain(0..excess);
    }
}

fn reset_budget(store: &mut impl SecretStore, kind: &str) {
    let Ok(mut inbox) = load_inbox(store) else {
        return;
    };
    inbox.budget = MAX_NETWORK_OPS;
    inbox.budget_reset = kind.to_owned();
    // A response may have been lost. Requested instances become unknown so the
    // next parked run can retry, but known state is preserved.
    for record in inbox.instances.values_mut() {
        if record.state == "requested" {
            record.state = "unknown".to_owned();
        }
        record.retry_next_wake = false;
    }
    let _ = write_json(store, INBOX_KEY, &inbox);
}

fn board_from_record(record: &InstanceRecord, owner: &str) -> Option<BoardState> {
    if record.state != "known" {
        return None;
    }
    let data = record.data.as_deref()?;
    let bytes = hex::decode(data).ok()?;
    BoardState::decode(&bytes, owner).ok()
}

struct ResolvedOwner {
    owner: String,
    index: usize,
    instance: [u8; 32],
    state: Option<BoardState>,
}

fn request_get(inbox: &mut InboxState, id: [u8; 32], out: &mut Vec<OutboundDelegateMsg>) {
    if inbox.budget == 0 {
        return;
    }
    let key = hex::encode(id);
    let record = inbox
        .instances
        .entry(key)
        .or_insert_with(|| InstanceRecord {
            state: "unknown".to_owned(),
            seq: 0,
            owner: None,
            data: None,
            retry_next_wake: false,
        });
    if record.state == "requested" || record.retry_next_wake {
        return;
    }
    record.state = "requested".to_owned();
    inbox.budget -= 1;
    out.push(OutboundDelegateMsg::GetContractRequest(
        GetContractRequest::new(ContractInstanceId::new(id)),
    ));
}

/// A `Busy` plan is the one failure that says "this board's own record may be
/// behind." The intent names us as the next actor but our copy still carries a
/// different non-terminal payment (the live smoke's B case). Ask for the own
/// board's committed state; the response lands in the cache and the next scan
/// compares it against the local copy.
///
/// Returns true when a refresh was requested (or was already in flight), so the
/// caller can stop planning this run instead of signing from a suspect copy.
fn request_own_refresh_on_busy(
    inbox: &mut InboxState,
    own_instance: [u8; 32],
    error: AdvanceError,
    out: &mut Vec<OutboundDelegateMsg>,
) -> bool {
    if error != AdvanceError::Busy {
        return false;
    }
    request_get(inbox, own_instance, out);
    true
}

/// Order two copies of a board by the records that decide a payment leg.
///
/// `payments.seq` is the discriminator for the stale-record bug: the node's
/// committed state and the notification cache can disagree, and the newer
/// payment record must win. Slot seqs break ties because a payment delta also
/// writes slots. Higher is fresher.
fn state_order(state: &BoardState) -> (u64, u64) {
    let slot_max = state.slots.iter().map(|slot| slot.seq).max().unwrap_or(0);
    (state.payments.seq, slot_max)
}

fn resolve_owner(
    host: &mut impl ContractHost,
    hashes: &[[u8; 32]],
    owner: &str,
    inbox: &mut InboxState,
    out: &mut Vec<OutboundDelegateMsg>,
) -> Result<ResolvedOwner, String> {
    let candidates = instance_candidates(hashes, owner)?;
    for (index, _hash, id) in &candidates {
        let key = hex::encode(id);
        // Both copies can be stale: the committed local state can lag the
        // network (a dropped update), and the notification cache can lag the
        // committed state. Take whichever has the newer payment/slot records,
        // and refresh the cache from the committed state when that wins.
        let local = host.local_state(id).and_then(|bytes| {
            BoardState::decode(&bytes, owner)
                .ok()
                .map(|state| (bytes, state))
        });
        let cached = inbox
            .instances
            .get(&key)
            .and_then(|record| board_from_record(record, owner));
        let chosen = match (local, cached) {
            (Some((bytes, local_state)), Some(cached_state)) => {
                if state_order(&cached_state) > state_order(&local_state) {
                    Some((None, cached_state))
                } else {
                    Some((Some(bytes), local_state))
                }
            }
            (Some((bytes, local_state)), None) => Some((Some(bytes), local_state)),
            (None, Some(cached_state)) => Some((None, cached_state)),
            (None, None) => None,
        };
        if let Some((bytes, state)) = chosen {
            match bytes {
                Some(bytes) => {
                    let record = InstanceRecord {
                        state: "known".to_owned(),
                        seq: state.payments.seq,
                        owner: Some(owner.to_owned()),
                        data: Some(hex::encode(&bytes)),
                        retry_next_wake: false,
                    };
                    inbox.instances.insert(key, record);
                }
                None => {
                    if let Some(record) = inbox.instances.get_mut(&key) {
                        record.seq = state.payments.seq;
                    }
                }
            }
            return Ok(ResolvedOwner {
                owner: owner.to_owned(),
                index: *index,
                instance: *id,
                state: Some(state),
            });
        }
    }

    // Nothing local resolved. Ask for the newest candidate and mark it
    // requested; a response resumes the scan.
    let (index, _hash, id) = candidates
        .into_iter()
        .next()
        .ok_or_else(|| "codeHashes must not be empty".to_string())?;
    request_get(inbox, id, out);
    Ok(ResolvedOwner {
        owner: owner.to_owned(),
        index,
        instance: id,
        state: None,
    })
}

fn ensure_subscription(
    subscriptions: &mut SubscriptionState,
    inbox: &mut InboxState,
    id: [u8; 32],
    force: bool,
    out: &mut Vec<OutboundDelegateMsg>,
) {
    if inbox.budget == 0 {
        return;
    }
    let already_queued = out
        .iter()
        .filter(|message| matches!(message, OutboundDelegateMsg::SubscribeContractRequest(_)))
        .count();
    if already_queued >= MAX_BOOTSTRAP_SUBSCRIBES {
        return;
    }
    let key = hex::encode(id);
    let already = subscriptions.subscribed.iter().any(|other| other == &key);
    if already && !force {
        return;
    }
    if !already {
        subscriptions.subscribed.push(key.clone());
    }
    if !subscriptions.pending.iter().any(|other| other == &key) {
        subscriptions.pending.push(key);
    }
    inbox.budget -= 1;
    out.push(OutboundDelegateMsg::SubscribeContractRequest(
        SubscribeContractRequest::new(ContractInstanceId::new(id)),
    ));
}

fn plan_is_final(address: &str, intent: &Payment) -> bool {
    let Ok(route) = advance::plan_route(&intent.src_addr, &intent.dst_addr) else {
        return false;
    };
    advance::actor_step(&route, intent.cursor, Some(address))
        .map(|step| step.next_address.is_none())
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn apply_plan(
    store: &mut impl ContractHost,
    inbox: &mut InboxState,
    own_instance: [u8; 32],
    own_state: &BoardState,
    plan: &LegPlan,
    from_owner: &str,
    out: &mut Vec<OutboundDelegateMsg>,
) -> Result<(), String> {
    if inbox.budget == 0 {
        return Err("network budget exhausted".into());
    }
    let key = dedup_key(&plan.payment, from_owner);
    let mut dedup = load_dedup(store)?;
    if dedup.keys.iter().any(|existing| existing == &key) {
        return Ok(());
    }
    // Record before signing so a crash mid-sign does not double-sign on the
    // next wake. A failed update clears it.
    dedup_insert(&mut dedup, key.clone());
    write_json(store, DEDUP_KEY, &dedup)?;

    let mut payment = plan.payment.clone();
    let mut delta_slots = Vec::with_capacity(plan.slots.len());
    for write in &plan.slots {
        let seq = own_state.slots[usize::from(write.index)]
            .seq
            .saturating_add(1)
            .max(read_next_seq(store, write.index)?);
        let sig = match sign_with(store, write.index, seq, Some(&write.entry)) {
            Ok(sig) => sig,
            Err(error) => {
                dedup_remove(&mut dedup, &key);
                let _ = write_json(store, DEDUP_KEY, &dedup);
                return Err(error);
            }
        };
        delta_slots.push(serde_json::json!({
            "i": write.index,
            "seq": seq,
            "entry": write.entry,
            "sig": sig,
        }));
        payment.legs.push(PaymentLeg {
            slot: write.index,
            seq,
            post_value: write.entry.value,
            sig,
        });
    }

    let payments_seq = own_state
        .payments
        .seq
        .saturating_add(1)
        .max(read_payments_next_seq(store)?);
    let payments_sig = match sign_payments_with(
        store,
        payments_seq,
        &own_state.payments.settled,
        Some(&payment),
    ) {
        Ok(sig) => sig,
        Err(error) => {
            dedup_remove(&mut dedup, &key);
            let _ = write_json(store, DEDUP_KEY, &dedup);
            return Err(error);
        }
    };

    let delta = serde_json::json!({
        "v": own_state.v,
        "parent": null,
        "contacts": null,
        "payments": {
            "seq": payments_seq,
            "settled": own_state.payments.settled,
            "entry": payment,
            "sig": payments_sig,
        },
        "slots": delta_slots,
    });
    let delta_bytes =
        serde_json::to_vec(&delta).map_err(|error| format!("failed to encode delta: {error}"))?;
    let mut request = UpdateContractRequest::new(
        ContractInstanceId::new(own_instance),
        UpdateData::Delta(StateDelta::from(delta_bytes)),
    );
    let context = serde_json::json!({ "dedup": key });
    request.context = DelegateContext::new(
        serde_json::to_vec(&context)
            .map_err(|error| format!("failed to encode context: {error}"))?,
    );
    out.push(OutboundDelegateMsg::UpdateContractRequest(request));
    inbox.budget -= 1;

    let mut audit = load_audit(store)?;
    audit_push(
        &mut audit,
        AuditEntry {
            id: plan.payment.id.clone(),
            cursor: plan.cursor,
            slots: audit_slots(plan),
            role: plan.role.as_str().to_owned(),
        },
    );
    write_json(store, AUDIT_KEY, &audit)?;
    Ok(())
}

fn record_instance_bytes(
    store: &mut impl SecretStore,
    contract_id: &ContractInstanceId,
    state: Option<Vec<u8>>,
) {
    let mut inbox = load_inbox(store).unwrap_or_default();
    let key = hex::encode(contract_id.as_bytes());
    let record = inbox
        .instances
        .entry(key)
        .or_insert_with(|| InstanceRecord {
            state: "unknown".to_owned(),
            seq: 0,
            owner: None,
            data: None,
            retry_next_wake: false,
        });
    match state {
        Some(bytes) => {
            record.state = "known".to_owned();
            record.data = Some(hex::encode(&bytes));
            record.retry_next_wake = false;
        }
        None => {
            record.state = "unknown".to_owned();
            record.data = None;
            record.retry_next_wake = true;
        }
    }
    let _ = write_json(store, INBOX_KEY, &inbox);
}

fn record_subscribe_response(store: &mut impl SecretStore, response: SubscribeContractResponse) {
    let key = hex::encode(response.contract_id.as_bytes());
    let mut subscriptions = load_subscriptions(store).unwrap_or_default();
    subscriptions.pending.retain(|other| other != &key);
    if response.result.is_err() {
        subscriptions.subscribed.retain(|other| other != &key);
    }
    let _ = write_json(store, SUBSCRIPTIONS_KEY, &subscriptions);
}

fn record_update_response(store: &mut impl SecretStore, response: UpdateContractResponse) {
    if response.result.is_err() {
        let mut inbox = load_inbox(store).unwrap_or_default();
        inbox.last_error = Some("update-failed".to_owned());
        let _ = write_json(store, INBOX_KEY, &inbox);
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(response.context.as_ref()) {
            if let Some(key) = value.get("dedup").and_then(|value| value.as_str()) {
                let mut dedup = load_dedup(store).unwrap_or_default();
                dedup_remove(&mut dedup, key);
                let _ = write_json(store, DEDUP_KEY, &dedup);
            }
        }
    }
}

fn scan(host: &mut impl ContractHost, force_subscribe: bool, out: &mut Vec<OutboundDelegateMsg>) {
    let Ok(Some(config)) = load_config(host) else {
        return;
    };
    let mut inbox = load_inbox(host).unwrap_or_default();
    inbox.last_scan = inbox.last_scan.saturating_add(1);
    if !config.auto_advance {
        // Disabled is a policy choice, not a failure; status carries the flag.
        inbox.last_error = None;
        let _ = write_json(host, INBOX_KEY, &inbox);
        return;
    }
    let hashes = match decode_hashes(&config.code_hashes) {
        Ok(hashes) => hashes,
        Err(error) => {
            inbox.last_error = Some(error);
            let _ = write_json(host, INBOX_KEY, &inbox);
            return;
        }
    };
    let seed = match load_seed(host) {
        Ok(seed) => seed,
        Err(error) => {
            inbox.last_error = Some(error);
            let _ = write_json(host, INBOX_KEY, &inbox);
            return;
        }
    };
    let owner_bytes = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let owner = hex::encode(owner_bytes);

    let own = match resolve_owner(host, &hashes, &owner, &mut inbox, out) {
        Ok(own) => own,
        Err(error) => {
            inbox.last_error = Some(error);
            let _ = write_json(host, INBOX_KEY, &inbox);
            return;
        }
    };
    inbox.matched_code_hash = config.code_hashes.get(own.index).cloned();

    // NodeStarted: re-subscribe own + parent unconditionally; the persisted set
    // is not authoritative after silent LRU eviction. Do this before the
    // version/state early returns so a local miss still restores demand.
    let mut subscriptions = load_subscriptions(host).unwrap_or_default();
    if force_subscribe {
        ensure_subscription(&mut subscriptions, &mut inbox, own.instance, true, out);
        if let Some(parent) = own.state.as_ref().and_then(|state| state.parent.as_deref()) {
            if let Ok((_, id)) = newest_instance(&hashes, parent) {
                ensure_subscription(&mut subscriptions, &mut inbox, id, true, out);
            }
        }
    }

    // A v8 build must not sign into a tree where its own board only resolves at
    // a legacy hash (state versions cannot be reconciled).
    if own.index > 0 {
        inbox.last_error = Some("mixed-version".to_owned());
        let _ = write_json(host, SUBSCRIPTIONS_KEY, &subscriptions);
        let _ = write_json(host, INBOX_KEY, &inbox);
        return;
    }

    let Some(own_state) = own.state.clone() else {
        // Step 1: a miss issues one GET and stops until the response.
        let _ = write_json(host, SUBSCRIPTIONS_KEY, &subscriptions);
        let _ = write_json(host, INBOX_KEY, &inbox);
        return;
    };

    let mut resolved: Vec<ResolvedOwner> = Vec::new();
    resolved.push(ResolvedOwner {
        owner: owner.clone(),
        index: own.index,
        instance: own.instance,
        state: Some(own_state.clone()),
    });

    let mut desired_owners: Vec<String> = vec![owner.clone()];
    if let Some(parent) = own_state.parent.clone() {
        desired_owners.push(parent);
    }
    for slot in &own_state.slots {
        if let Some(entry) = &slot.entry {
            desired_owners.push(entry.contact.clone());
        }
    }
    desired_owners.sort();
    desired_owners.dedup();

    // Rotate the inbox by a persisted cursor. The per-run GET budget is small
    // (4) while the inbox is up to 10 boards, so a fixed order would let a few
    // offline/unknown neighbours consume every request and starve the rest.
    // The cursor advances once per scan, so each run samples a different window.
    if !desired_owners.is_empty() {
        let offset = inbox.cursor % desired_owners.len();
        desired_owners.rotate_left(offset);
    }

    for desired in &desired_owners {
        if desired == &owner {
            let id = own.instance;
            ensure_subscription(&mut subscriptions, &mut inbox, id, false, out);
            continue;
        }
        match resolve_owner(host, &hashes, desired, &mut inbox, out) {
            Ok(entry) => {
                ensure_subscription(&mut subscriptions, &mut inbox, entry.instance, false, out);
                resolved.push(entry);
            }
            Err(error) => {
                inbox.last_error = Some(error);
            }
        }
    }

    // Validate the configured address against the parent board when readable.
    if let Some(parent_owner) = own_state.parent.as_deref() {
        let digit = config.address.as_bytes().last().map(|byte| byte - b'0');
        let parent_state = resolved
            .iter()
            .find(|entry| entry.owner == parent_owner)
            .and_then(|entry| entry.state.as_ref());
        let matches = match (digit, parent_state) {
            (Some(digit), Some(parent_state)) if digit < 8 => parent_state
                .slots
                .get(usize::from(digit))
                .and_then(|slot| slot.entry.as_ref())
                .is_some_and(|entry| entry.contact == owner),
            (_, Some(_)) => false,
            // Parent not readable yet: leave validation for the next pass.
            (_, None) => true,
        };
        if !matches {
            inbox.last_error = Some("address-mismatch".to_owned());
            let _ = write_json(host, INBOX_KEY, &inbox);
            return;
        }
    } else if !config.address.is_empty() {
        inbox.last_error = Some("address-mismatch".to_owned());
        let _ = write_json(host, INBOX_KEY, &inbox);
        return;
    }

    // Scan known neighbours for a forward intent naming this owner.
    for neighbour in &resolved {
        if neighbour.owner == owner {
            continue;
        }
        let Some(from_state) = neighbour.state.as_ref() else {
            continue;
        };
        let Some(intent) = from_state.payments.entry.as_ref() else {
            continue;
        };
        if intent.next != owner
            || intent.phase != "forward"
            || !matches!(intent.status.as_str(), "offered" | "acted")
        {
            continue;
        }

        let destination = if plan_is_final(&config.address, intent) {
            match resolve_owner(host, &hashes, &intent.dst, &mut inbox, out) {
                Ok(resolved_destination) => resolved_destination.state,
                Err(error) => {
                    inbox.last_error = Some(error);
                    None
                }
            }
        } else {
            None
        };
        if plan_is_final(&config.address, intent) && destination.is_none() {
            inbox.last_error = Some("destination-unknown".to_owned());
            continue;
        }

        let own_board = OwnBoard {
            state: &own_state,
            address: &config.address,
            destination: destination.as_ref(),
        };
        match advance::plan_leg(
            &own_board,
            intent,
            from_state,
            &neighbour.owner,
            config.max_amount,
        ) {
            Ok(plan) => {
                if let Err(error) = apply_plan(
                    host,
                    &mut inbox,
                    own.instance,
                    &own_state,
                    &plan,
                    &neighbour.owner,
                    out,
                ) {
                    inbox.last_error = Some(error);
                    break;
                }
                inbox.last_error = None;
                // One update per parked run: `own_state` is the pre-update
                // snapshot, so planning a second leg from it would recompute
                // slot values without the first leg. The next wake re-reads.
                break;
            }
            Err(error) => {
                inbox.last_error = Some(error.code().to_owned());
                if request_own_refresh_on_busy(&mut inbox, own.instance, error, out) {
                    // Do not sign another leg from a copy suspected stale.
                    break;
                }
            }
        }
    }

    if !desired_owners.is_empty() {
        inbox.cursor = inbox.cursor.wrapping_add(1) % desired_owners.len();
    }
    let _ = write_json(host, INBOX_KEY, &inbox);
    let _ = write_json(host, SUBSCRIPTIONS_KEY, &subscriptions);
}

fn handle_background(
    host: &mut impl ContractHost,
    message: InboundDelegateMsg,
) -> Vec<OutboundDelegateMsg> {
    let mut out = Vec::new();
    match message {
        InboundDelegateMsg::Lifecycle(LifecycleEvent::NodeStarted { .. }) => {
            reset_budget(host, "node_start");
            scan(host, true, &mut out);
        }
        InboundDelegateMsg::Lifecycle(_) => {}
        InboundDelegateMsg::WakeupFired { tag } if tag == b"inbox" => {
            reset_budget(host, "wakeup");
            scan(host, false, &mut out);
        }
        InboundDelegateMsg::WakeupFired { .. } => {}
        InboundDelegateMsg::ContractNotification(notification) => {
            record_instance_bytes(
                host,
                &notification.contract_id,
                Some(notification.new_state.to_vec()),
            );
            scan(host, false, &mut out);
        }
        InboundDelegateMsg::GetContractResponse(response) => {
            record_instance_bytes(
                host,
                &response.contract_id,
                response.state.map(|s| s.to_vec()),
            );
            scan(host, false, &mut out);
        }
        InboundDelegateMsg::UpdateContractResponse(response) => {
            record_update_response(host, response);
            scan(host, false, &mut out);
        }
        InboundDelegateMsg::SubscribeContractResponse(response) => {
            record_subscribe_response(host, response);
            scan(host, false, &mut out);
        }
        InboundDelegateMsg::PutContractResponse(_) => {
            scan(host, false, &mut out);
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use proptest::prelude::*;
    use serde_json::{Value, json};

    use super::*;

    /// Golden vector: seed `[7u8; 32]`, slot 3, seq 7,
    /// `{ value: 12, contact: 0x11 × 32, unit: null, note: null }`.
    /// Changing the signing-byte format changes the signature and fails here.
    const GOLDEN_PUBKEY: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
    const GOLDEN_SLOT_SIGNATURE: &str = "f666bc2cac7ec8a21df38dfde44d09d80a8318400850c9e6bd72173eafbc9d68106ddce7a122f85bbb9253d13d95b9accad3e4bad3a0ee24fcf424fe17088201";
    /// Golden contacts vector: seq 1, `[{ label: "Alice", userId: 0x11 × 32 }]`.
    const GOLDEN_CONTACTS_SIGNATURE: &str = "c23847c3587eb9d295db216d0933aa592a54d5374232efa456c4e0cf64b5194da1a58aa0939fbf5a6bef2024ff8ac152ea75afe3a9a1cc655a4979de43cb0906";
    /// Golden parent vector: seq 1, `userId: 0x11 × 32`.
    const GOLDEN_PARENT_SIGNATURE: &str = "83620d873b5179b726f2aab882083d4d74fa6eee90726ada5b44b74d1d3f48e2e6b31dac5b31142febeb1d6505e426d659c0907adf3110cdddb3984b0bc80400";
    /// Golden payments vector: seed `[7u8; 32]`, seq 1, empty settled list,
    /// `payment_sample()`.
    ///
    /// The bytes are assembled directly from `DESIGN-payments.md`, including
    /// the `settled_count` byte. Do not change this literal without changing
    /// the spec.
    const GOLDEN_PAYMENTS_BYTES: &str = "6e756d6265723a76343a7061796d656e7473010000000000000000011111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333e20400000000000002000000353202000000333102000100444444444444444444444444444444444444444444444444444444444444444401010400000000000000a60e00000000000055555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555";
    const GOLDEN_PAYMENTS_SIGNATURE: &str = "748f0c2f40fd5d5db43da9116cf8afd62186dafe1264b579d667cb7e5988266fba1f1bf5e7b196b47b2b8248f252cc9e32914b167916a60f00b56d5beaf57704";

    const CONTACT_11: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const CONTACT_22: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    #[derive(Default)]
    struct MemoryStore {
        secrets: BTreeMap<Vec<u8>, Vec<u8>>,
        contracts: BTreeMap<Vec<u8>, Vec<u8>>,
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

    impl ContractHost for MemoryStore {
        fn local_state(&self, instance: &[u8; 32]) -> Option<Vec<u8>> {
            self.contracts.get(instance.as_slice()).cloned()
        }
    }

    fn store_with_seed(seed: [u8; 32]) -> MemoryStore {
        let mut store = MemoryStore::default();
        assert!(store.set_secret(SECRET_SEED, &seed));
        store
    }

    fn expected_webapp_id() -> ContractInstanceId {
        ContractInstanceId::new([0x42; 32])
    }

    fn webapp_origin(id: ContractInstanceId) -> MessageOrigin {
        MessageOrigin::WebApp(id)
    }

    fn call(store: &mut MemoryStore, payload: &[u8]) -> Value {
        let expected = expected_webapp_id();
        let origin = webapp_origin(expected);
        let bytes = handle_application_message(store, expected, Some(&origin), payload);
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

    fn contact(label: &str, user_id: &str) -> Contact {
        Contact {
            label: label.into(),
            user_id: user_id.into(),
        }
    }

    const PAYMENT_ID: &str = "11111111111111111111111111111111";
    const PAYMENT_NEXT: &str = "4444444444444444444444444444444444444444444444444444444444444444";
    const LEG_SIG: &str = "55555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555";

    fn payment_leg(slot: u8, seq: u64, post_value: i64) -> PaymentLeg {
        PaymentLeg {
            slot,
            seq,
            post_value,
            sig: LEG_SIG.into(),
        }
    }

    /// The pinned golden vector for the payments encoding.
    fn payment_sample() -> Payment {
        Payment {
            id: PAYMENT_ID.into(),
            src: CONTACT_22.into(),
            dst: "33".repeat(32),
            amount: 1250,
            src_addr: "52".into(),
            dst_addr: "31".into(),
            cursor: 2,
            phase: "forward".into(),
            status: "acted".into(),
            next: PAYMENT_NEXT.into(),
            fail: None,
            legs: vec![payment_leg(1, 4, 3750)],
        }
    }

    /// `count` distinct settled payment ids (32 lowercase hex chars each).
    fn settled_ids(count: usize) -> Vec<String> {
        (0..count).map(|index| format!("{index:032x}")).collect()
    }

    #[test]
    fn identity_is_stable_and_defaults_counters_to_one() {
        let mut store = MemoryStore::default();

        let first = call(&mut store, br#"{"cmd":"identity"}"#);
        let second = call(&mut store, br#"{"cmd":"identity"}"#);

        assert!(is_ok(&first));
        assert!(is_ok(&second));
        assert_eq!(first["pubkey"], second["pubkey"]);
        assert_eq!(first["nextSeq"], json!([1, 1, 1, 1, 1, 1, 1, 1]));
        assert_eq!(first["contactsNextSeq"], 1);
        assert_eq!(first["parentNextSeq"], 1);
        assert_eq!(first["paymentsNextSeq"], 1);
        assert_eq!(
            store.secrets.get(SECRET_SEED).map(Vec::len),
            Some(32),
            "identity must persist a 32-byte seed"
        );
    }

    #[test]
    fn status_does_not_create_a_seed() {
        let mut store = MemoryStore::default();
        let response = call(&mut store, br#"{"cmd":"status"}"#);

        assert!(is_ok(&response));
        assert_eq!(response["hasSeed"], false);
        assert!(store.secrets.is_empty(), "status must not create a seed");
    }

    #[test]
    fn export_requires_an_existing_seed() {
        let mut store = MemoryStore::default();
        let response = call(&mut store, br#"{"cmd":"export"}"#);

        assert!(!is_ok(&response));
        assert!(error_text(&response).contains("no seed"));
        assert!(
            store.secrets.is_empty(),
            "a refused export must not create a seed"
        );
    }

    #[test]
    fn export_import_round_trip_preserves_identity_and_counters() {
        let mut old = store_with_seed([7u8; 32]);
        assert!(old.set_secret(&next_seq_key(3), &9u64.to_le_bytes()));
        assert!(old.set_secret(CONTACTS_NEXTSEQ_KEY, &7u64.to_le_bytes()));
        assert!(old.set_secret(PARENT_NEXTSEQ_KEY, &5u64.to_le_bytes()));
        assert!(old.set_secret(PAYMENTS_NEXTSEQ_KEY, &3u64.to_le_bytes()));

        let exported = call(&mut old, br#"{"cmd":"export"}"#);
        assert!(is_ok(&exported), "unexpected export: {exported}");
        assert_eq!(exported["version"], DELEGATE_VERSION);
        assert_eq!(exported["seed"], "07".repeat(32));
        assert_eq!(exported["nextSeq"][3], 9);
        assert_eq!(exported["contactsNextSeq"], 7);
        assert_eq!(exported["parentNextSeq"], 5);
        assert_eq!(exported["paymentsNextSeq"], 3);

        let mut new = MemoryStore::default();
        let payload = format!(
            r#"{{"cmd":"import","seed":"{}","nextSeq":{},"contactsNextSeq":{},"parentNextSeq":{},"paymentsNextSeq":{}}}"#,
            exported["seed"].as_str().unwrap(),
            exported["nextSeq"],
            exported["contactsNextSeq"],
            exported["parentNextSeq"],
            exported["paymentsNextSeq"]
        );
        let imported = call(&mut new, payload.as_bytes());
        assert!(is_ok(&imported), "unexpected import: {imported}");

        let identity = call(&mut new, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["pubkey"], GOLDEN_PUBKEY);
        assert_eq!(identity["nextSeq"][3], 9);
        assert_eq!(identity["contactsNextSeq"], 7);
        assert_eq!(identity["parentNextSeq"], 5);
        assert_eq!(identity["paymentsNextSeq"], 3);
    }

    #[test]
    fn import_defaults_counters_for_v1_v4_predecessors() {
        let mut new = MemoryStore::default();
        let payload = format!(
            r#"{{"cmd":"import","seed":"{}","nextSeq":[1,1,1,1,1,1,1,1]}}"#,
            "07".repeat(32)
        );
        let imported = call(&mut new, payload.as_bytes());
        assert!(is_ok(&imported), "unexpected import: {imported}");

        let identity = call(&mut new, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["contactsNextSeq"], 1);
        assert_eq!(identity["parentNextSeq"], 1);
        assert_eq!(identity["paymentsNextSeq"], 1);

        // A v4-style export has contactsNextSeq but no parentNextSeq.
        let mut v4 = MemoryStore::default();
        let payload = format!(
            r#"{{"cmd":"import","seed":"{}","nextSeq":[1,1,1,1,1,1,1,1],"contactsNextSeq":4}}"#,
            "07".repeat(32)
        );
        let imported = call(&mut v4, payload.as_bytes());
        assert!(is_ok(&imported), "unexpected import: {imported}");
        let identity = call(&mut v4, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["contactsNextSeq"], 4);
        assert_eq!(identity["parentNextSeq"], 1);
        assert_eq!(identity["paymentsNextSeq"], 1);
    }

    #[test]
    fn import_refuses_to_replace_an_existing_seed() {
        let mut store = store_with_seed([7u8; 32]);
        let payload = format!(
            r#"{{"cmd":"import","seed":"{}","nextSeq":[1,1,1,1,1,1,1,1]}}"#,
            "09".repeat(32)
        );
        let response = call(&mut store, payload.as_bytes());

        assert!(!is_ok(&response));
        assert!(error_text(&response).contains("already has a seed"));

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["pubkey"], GOLDEN_PUBKEY);
    }

    #[test]
    fn import_validates_the_seed_and_counters() {
        let cases = [
            (
                r#"{"cmd":"import","seed":"zz","nextSeq":[1,1,1,1,1,1,1,1]}"#,
                "hex",
            ),
            (
                r#"{"cmd":"import","seed":"00","nextSeq":[1,1,1,1,1,1,1,1]}"#,
                "32 bytes",
            ),
            (
                r#"{"cmd":"import","seed":"0000000000000000000000000000000000000000000000000000000000000000","nextSeq":[1,1,1]}"#,
                "8 entries",
            ),
            (
                r#"{"cmd":"import","seed":"0000000000000000000000000000000000000000000000000000000000000000","nextSeq":[1,1,1,0,1,1,1,1]}"#,
                "greater than 0",
            ),
            (
                r#"{"cmd":"import","seed":"0000000000000000000000000000000000000000000000000000000000000000","nextSeq":[1,1,1,1,1,1,1,1],"contactsNextSeq":0}"#,
                "greater than 0",
            ),
            (
                r#"{"cmd":"import","seed":"0000000000000000000000000000000000000000000000000000000000000000","nextSeq":[1,1,1,1,1,1,1,1],"parentNextSeq":0}"#,
                "greater than 0",
            ),
            (
                r#"{"cmd":"import","seed":"0000000000000000000000000000000000000000000000000000000000000000","nextSeq":[1,1,1,1,1,1,1,1],"paymentsNextSeq":0}"#,
                "paymentsNextSeq",
            ),
        ];

        for (payload, expected) in cases {
            let mut store = MemoryStore::default();
            let response = call(&mut store, payload.as_bytes());
            assert!(!is_ok(&response), "payload must be rejected: {payload}");
            assert!(
                error_text(&response).contains(expected),
                "error for {payload} did not contain {expected}: {response}"
            );
            assert!(
                store.secrets.is_empty(),
                "a rejected import must not write any secrets"
            );
        }
    }

    #[test]
    fn golden_slot_signing_vector() {
        let mut store = store_with_seed([7u8; 32]);

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["pubkey"], GOLDEN_PUBKEY);

        let response = call(
            &mut store,
            br#"{"cmd":"sign","slot":3,"seq":7,"entry":{"value":12,"contact":"1111111111111111111111111111111111111111111111111111111111111111","unit":null,"note":null}}"#,
        );

        assert!(is_ok(&response), "unexpected response: {response}");
        assert_eq!(response["sig"], GOLDEN_SLOT_SIGNATURE);

        // Independently confirm the pinned signature verifies under the pinned
        // public key, so this test fails on drift rather than merely on a typo.
        let entry = Entry {
            value: 12,
            contact: CONTACT_11.into(),
            unit: None,
            note: None,
        };
        // Pin the bytes themselves, not just the signature: this is the
        // cross-crate contract (`contract/src/lib.rs` asserts the same hex).
        assert_eq!(
            hex::encode(signing_bytes(3, 7, Some(&entry))),
            "6e756d6265723a76323a736c6f74030700000000000000010c0000000000000011111111111111111111111111111111111111111111111111111111111111110000000000000000"
        );
        let verifying_key = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let signature: [u8; 64] = hex::decode(GOLDEN_SLOT_SIGNATURE)
            .expect("golden signature is hex")
            .try_into()
            .expect("golden signature is 64 bytes");
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        verifying_key
            .verify_strict(&signing_bytes(3, 7, Some(&entry)), &signature)
            .expect("golden signature verifies over the canonical bytes");
    }

    #[test]
    fn golden_contacts_signing_vector() {
        let mut store = store_with_seed([7u8; 32]);

        let response = call(
            &mut store,
            br#"{"cmd":"signContacts","seq":1,"entries":[{"label":"Alice","userId":"1111111111111111111111111111111111111111111111111111111111111111"}]}"#,
        );

        assert!(is_ok(&response), "unexpected response: {response}");
        assert_eq!(response["sig"], GOLDEN_CONTACTS_SIGNATURE);

        let entries = vec![contact("Alice", CONTACT_11)];
        // Cross-crate pin: `contract/src/lib.rs` asserts this same hex.
        assert_eq!(
            hex::encode(contacts_signing_bytes(1, &entries)),
            "6e756d6265723a76323a636f6e746163747301000000000000000100000005000000416c6963651111111111111111111111111111111111111111111111111111111111111111"
        );
        let verifying_key = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let signature: [u8; 64] = hex::decode(GOLDEN_CONTACTS_SIGNATURE)
            .expect("golden signature is hex")
            .try_into()
            .expect("golden signature is 64 bytes");
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        verifying_key
            .verify_strict(&contacts_signing_bytes(1, &entries), &signature)
            .expect("golden contacts signature verifies over the canonical bytes");
    }

    #[test]
    fn golden_parent_signing_vector() {
        let mut store = store_with_seed([7u8; 32]);

        let response = call(
            &mut store,
            br#"{"cmd":"signParent","seq":1,"userId":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
        );
        assert!(is_ok(&response), "unexpected response: {response}");

        // Cross-crate pin: `contract/src/lib.rs` asserts this same hex/digest.
        assert_eq!(
            hex::encode(parent_signing_bytes(1, Some(CONTACT_11))),
            "6e756d6265723a76333a706172656e740100000000000000011111111111111111111111111111111111111111111111111111111111111111"
        );
        assert_eq!(
            hex::encode(parent_signing_bytes(1, None)),
            "6e756d6265723a76333a706172656e74010000000000000000"
        );
        assert_eq!(response["sig"], GOLDEN_PARENT_SIGNATURE);

        let verifying_key = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let signature: [u8; 64] = hex::decode(GOLDEN_PARENT_SIGNATURE)
            .expect("golden signature is hex")
            .try_into()
            .expect("golden signature is 64 bytes");
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        verifying_key
            .verify_strict(&parent_signing_bytes(1, Some(CONTACT_11)), &signature)
            .expect("golden parent signature verifies over the canonical bytes");
    }

    #[test]
    fn payments_counters_default_to_one_in_identity_status_and_export() {
        let mut store = MemoryStore::default();

        // Before a seed exists, status must not invent a payments counter.
        let status = call(&mut store, br#"{"cmd":"status"}"#);
        assert!(is_ok(&status));
        assert!(status.get("paymentsNextSeq").is_none());

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert!(is_ok(&identity));
        assert_eq!(identity["paymentsNextSeq"], 1);

        let status = call(&mut store, br#"{"cmd":"status"}"#);
        assert_eq!(status["paymentsNextSeq"], 1);

        let export = call(&mut store, br#"{"cmd":"export"}"#);
        assert!(is_ok(&export));
        assert_eq!(export["paymentsNextSeq"], 1);
    }

    #[test]
    fn golden_payments_signing_vector() {
        let entry = payment_sample();

        assert_eq!(
            hex::encode(payments_signing_bytes(1, &[], Some(&entry)).expect("entry is valid")),
            GOLDEN_PAYMENTS_BYTES
        );
        // Cross-pin to `contract/payments_golden_vector.txt` is pending; the
        // literal above is assembled directly from the design spec.
        assert_eq!(
            hex::encode(payments_signing_bytes(1, &[], None).expect("tombstone is valid")),
            "6e756d6265723a76343a7061796d656e747301000000000000000000"
        );

        let mut store = store_with_seed([7u8; 32]);
        let payload = serde_json::to_vec(&json!({"cmd": "signPayments", "seq": 1, "entry": entry}))
            .expect("request serializes");
        let response = call(&mut store, &payload);
        assert!(is_ok(&response), "unexpected response: {response}");
        assert_eq!(response["sig"], GOLDEN_PAYMENTS_SIGNATURE);

        let verifying_key = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let signature: [u8; 64] = hex::decode(GOLDEN_PAYMENTS_SIGNATURE)
            .expect("golden signature is hex")
            .try_into()
            .expect("golden signature is 64 bytes");
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        let bytes =
            payments_signing_bytes(1, &[], Some(&payment_sample())).expect("entry is valid");
        assert_eq!(hex::encode(&bytes), GOLDEN_PAYMENTS_BYTES);
        verifying_key
            .verify_strict(&bytes, &signature)
            .expect("golden payments signature verifies over the canonical bytes");
    }

    #[test]
    fn payments_signing_bytes_match_the_contract_pinned_vectors() {
        // These two literals are the vectors pinned by tests in
        // `contract/src/lib.rs` (seq 6 forward, seq 7 terminal with two legs)
        // with an empty settled list. They pin the shared encoding across the
        // two crates.
        let forward = Payment {
            id: "0123456789abcdef0123456789abcdef".into(),
            src: CONTACT_11.into(),
            dst: CONTACT_22.into(),
            amount: 1250,
            src_addr: "52".into(),
            dst_addr: "31".into(),
            cursor: 2,
            phase: "forward".into(),
            status: "acted".into(),
            next: "33".repeat(32),
            fail: None,
            legs: vec![PaymentLeg {
                slot: 1,
                seq: 4,
                post_value: 3750,
                sig: "5a".repeat(64),
            }],
        };
        assert_eq!(
            hex::encode(payments_signing_bytes(6, &[], Some(&forward)).expect("entry is valid")),
            "6e756d6265723a76343a7061796d656e7473060000000000000000010123456789abcdef0123456789abcdef11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222e20400000000000002000000353202000000333102000100333333333333333333333333333333333333333333333333333333333333333301010400000000000000a60e0000000000005a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
        );

        let terminal = Payment {
            cursor: 5,
            phase: "terminal".into(),
            status: "complete".into(),
            next: "00".repeat(32),
            legs: vec![
                PaymentLeg {
                    slot: 1,
                    seq: 4,
                    post_value: 3750,
                    sig: "5a".repeat(64),
                },
                PaymentLeg {
                    slot: 3,
                    seq: 5,
                    post_value: -1250,
                    sig: "5a".repeat(64),
                },
            ],
            ..forward.clone()
        };
        assert_eq!(
            hex::encode(payments_signing_bytes(7, &[], Some(&terminal)).expect("entry is valid")),
            "6e756d6265723a76343a7061796d656e7473070000000000000000010123456789abcdef0123456789abcdef11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222e20400000000000002000000353202000000333105020200000000000000000000000000000000000000000000000000000000000000000002010400000000000000a60e0000000000005a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0305000000000000001efbffffffffffff5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
        );

        // Real cross-pin: when the shared artifact exists, read the hex from it
        // rather than trusting the literals above.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../contract/payments_golden_vector.txt");
        let Ok(text) = std::fs::read_to_string(&path) else {
            // The shared vector is produced by the contract slice; absent means
            // the cross-pin is pending.
            return;
        };
        let pinned: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| {
                line.len() > 64
                    && line
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() || byte == b' ')
            })
            .collect();
        assert_eq!(pinned.len(), 3, "unexpected format in {}", path.display());

        let forward_bytes = payments_signing_bytes(6, &[], Some(&forward)).expect("entry is valid");
        let terminal_bytes =
            payments_signing_bytes(7, &[], Some(&terminal)).expect("entry is valid");
        let settled = vec!["aa".repeat(16), "bb".repeat(16)];
        let settled_bytes =
            payments_signing_bytes(9, &settled, Some(&forward)).expect("entry is valid");

        assert_eq!(pinned[0], hex::encode(forward_bytes));
        assert_eq!(pinned[1], hex::encode(terminal_bytes));
        assert_eq!(pinned[2], hex::encode(settled_bytes));
    }

    #[test]
    fn sign_payments_advances_the_counter_and_rejects_invalid_entries() {
        let mut store = store_with_seed([7u8; 32]);
        let payload = serde_json::to_vec(
            &json!({"cmd": "signPayments", "seq": 1, "entry": payment_sample()}),
        )
        .expect("request serializes");

        let accepted = call(&mut store, &payload);
        assert!(is_ok(&accepted), "unexpected response: {accepted}");
        assert_eq!(accepted["sig"], GOLDEN_PAYMENTS_SIGNATURE);
        assert_eq!(
            store.secrets.get(PAYMENTS_NEXTSEQ_KEY).cloned(),
            Some(2u64.to_le_bytes().to_vec())
        );

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["paymentsNextSeq"], 2);

        let replay = call(&mut store, &payload);
        assert!(!is_ok(&replay));
        assert!(error_text(&replay).contains("stale"));

        let zero = call(
            &mut store,
            br#"{"cmd":"signPayments","seq":0,"entry":null}"#,
        );
        assert!(!is_ok(&zero));
        assert!(error_text(&zero).contains("greater than 0"));

        let cases: Vec<(Payment, &str)> = vec![
            (
                Payment {
                    id: "11".repeat(15),
                    ..payment_sample()
                },
                "id",
            ),
            (
                Payment {
                    src: "22".repeat(31),
                    ..payment_sample()
                },
                "src",
            ),
            (
                Payment {
                    dst: "AA".repeat(32),
                    ..payment_sample()
                },
                "dst",
            ),
            (
                Payment {
                    amount: 0,
                    ..payment_sample()
                },
                "amount",
            ),
            (
                Payment {
                    amount: -1,
                    ..payment_sample()
                },
                "amount",
            ),
            (
                Payment {
                    src_addr: "8".into(),
                    ..payment_sample()
                },
                "srcAddr",
            ),
            (
                Payment {
                    src_addr: "0".repeat(MAX_ADDRESS_DIGITS + 1),
                    ..payment_sample()
                },
                "srcAddr",
            ),
            (
                Payment {
                    cursor: MAX_PAYMENT_CURSOR + 1,
                    ..payment_sample()
                },
                "cursor",
            ),
            (
                Payment {
                    phase: "sideways".into(),
                    ..payment_sample()
                },
                "phase",
            ),
            (
                Payment {
                    status: "pending".into(),
                    ..payment_sample()
                },
                "status",
            ),
            (
                Payment {
                    fail: Some("oops".into()),
                    ..payment_sample()
                },
                "fail",
            ),
            (
                Payment {
                    next: "44".repeat(31),
                    ..payment_sample()
                },
                "next",
            ),
            (
                Payment {
                    phase: "terminal".into(),
                    ..payment_sample()
                },
                "all zero",
            ),
            (
                Payment {
                    status: "offered".into(),
                    ..payment_sample()
                },
                "offered",
            ),
            (
                Payment {
                    status: "complete".into(),
                    ..payment_sample()
                },
                "terminal",
            ),
            (
                Payment {
                    legs: vec![
                        payment_leg(1, 4, 3750),
                        payment_leg(2, 5, 4000),
                        payment_leg(3, 6, 4250),
                    ],
                    ..payment_sample()
                },
                "maximum",
            ),
            (
                Payment {
                    legs: vec![payment_leg(1, 4, 3750), payment_leg(1, 5, 4000)],
                    ..payment_sample()
                },
                "duplicates slot",
            ),
            (
                Payment {
                    legs: vec![payment_leg(8, 4, 3750)],
                    ..payment_sample()
                },
                "out of range",
            ),
            (
                Payment {
                    legs: vec![payment_leg(1, 0, 3750)],
                    ..payment_sample()
                },
                "leg 0 seq",
            ),
            (
                Payment {
                    legs: vec![PaymentLeg {
                        sig: "55".into(),
                        ..payment_leg(1, 4, 3750)
                    }],
                    ..payment_sample()
                },
                "sig",
            ),
        ];

        for (entry, expected) in cases {
            let mut fresh = store_with_seed([7u8; 32]);
            let error = sign_payments_with(&mut fresh, 1, &[], Some(&entry))
                .expect_err("invalid payment must be rejected");
            assert!(
                error.contains(expected),
                "error {error:?} did not contain {expected:?}"
            );
            assert_eq!(
                fresh.secrets.get(PAYMENTS_NEXTSEQ_KEY),
                None,
                "a rejected payment must not advance the counter"
            );
        }
    }

    #[test]
    fn payments_tombstone_signs_at_a_positive_seq() {
        let mut store = store_with_seed([7u8; 32]);

        let tombstone = call(
            &mut store,
            br#"{"cmd":"signPayments","seq":3,"entry":null}"#,
        );
        assert!(is_ok(&tombstone), "unexpected response: {tombstone}");
        assert_eq!(
            store.secrets.get(PAYMENTS_NEXTSEQ_KEY).cloned(),
            Some(4u64.to_le_bytes().to_vec())
        );

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["paymentsNextSeq"], 4);

        let zero = call(
            &mut store,
            br#"{"cmd":"signPayments","seq":0,"entry":null}"#,
        );
        assert!(!is_ok(&zero));
        assert!(error_text(&zero).contains("greater than 0"));

        // A tombstone may carry settled ids: clearing the active entry does
        // not erase the replay guard.
        let settled = vec!["cd".repeat(16)];
        let payload = serde_json::to_vec(&json!({
            "cmd": "signPayments",
            "seq": 4,
            "settled": settled,
            "entry": null,
        }))
        .expect("request serializes");
        let accepted = call(&mut store, &payload);
        assert!(is_ok(&accepted), "unexpected response: {accepted}");
        assert_eq!(
            store.secrets.get(PAYMENTS_NEXTSEQ_KEY).cloned(),
            Some(5u64.to_le_bytes().to_vec())
        );

        let bytes = payments_signing_bytes(4, &settled, None).expect("tombstone is valid");
        let signature: [u8; 64] = hex::decode(accepted["sig"].as_str().unwrap())
            .expect("signature is hex")
            .try_into()
            .expect("signature is 64 bytes");
        SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .verify_strict(&bytes, &ed25519_dalek::Signature::from_bytes(&signature))
            .expect("tombstone signature covers the settled ids");
    }

    #[test]
    fn payments_settled_participates_in_the_signature() {
        let settled = settled_ids(2);
        let mut store = store_with_seed([7u8; 32]);
        let payload = serde_json::to_vec(&json!({
            "cmd": "signPayments",
            "seq": 1,
            "settled": settled,
            "entry": payment_sample(),
        }))
        .expect("request serializes");
        let response = call(&mut store, &payload);
        assert!(is_ok(&response), "unexpected response: {response}");

        let signature: [u8; 64] = hex::decode(response["sig"].as_str().unwrap())
            .expect("signature is hex")
            .try_into()
            .expect("signature is 64 bytes");
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        let verifying_key = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let bytes =
            payments_signing_bytes(1, &settled, Some(&payment_sample())).expect("entry is valid");
        verifying_key
            .verify_strict(&bytes, &signature)
            .expect("signature covers the settled ids");

        // Tampering with one settled id changes the signed bytes and the
        // signature no longer verifies.
        let mut tampered = settled.clone();
        tampered[0] = "ff".repeat(16);
        let tampered_bytes =
            payments_signing_bytes(1, &tampered, Some(&payment_sample())).expect("entry is valid");
        assert_ne!(tampered_bytes, bytes);
        assert!(
            verifying_key
                .verify_strict(&tampered_bytes, &signature)
                .is_err(),
            "a tampered settled id must not verify"
        );

        // The same entry with no settled ids is a different signed record.
        let without =
            payments_signing_bytes(1, &[], Some(&payment_sample())).expect("entry is valid");
        assert_ne!(without, bytes);
        assert!(verifying_key.verify_strict(&without, &signature).is_err());
    }

    #[test]
    fn sign_payments_rejects_malformed_settled_lists() {
        let good = "ab".repeat(16);
        let cases: Vec<(Vec<String>, &str)> = vec![
            (vec!["ab".repeat(15)], "settled id 0"),
            (vec![good.to_uppercase()], "settled id 0"),
            (vec!["zz".repeat(16)], "settled id 0"),
            (vec![good.clone(), good.clone()], "duplicates"),
            (settled_ids(MAX_SETTLED_PAYMENTS + 1), "maximum"),
        ];

        for (settled, expected) in cases {
            let mut store = store_with_seed([7u8; 32]);
            let error = sign_payments_with(&mut store, 1, &settled, Some(&payment_sample()))
                .expect_err("invalid settled list must be rejected");
            assert!(
                error.contains(expected),
                "error {error:?} did not contain {expected:?}"
            );
            assert_eq!(
                store.secrets.get(PAYMENTS_NEXTSEQ_KEY),
                None,
                "a rejected settled list must not advance the counter"
            );
        }

        // Exactly the cap is accepted.
        let settled = settled_ids(MAX_SETTLED_PAYMENTS);
        let mut store = store_with_seed([7u8; 32]);
        assert!(
            sign_payments_with(&mut store, 1, &settled, Some(&payment_sample())).is_ok(),
            "the settled cap itself must be accepted"
        );
        assert_eq!(
            store.secrets.get(PAYMENTS_NEXTSEQ_KEY).cloned(),
            Some(2u64.to_le_bytes().to_vec())
        );
    }

    #[test]
    fn sign_parent_advances_the_counter_and_rejects_stale_seqs() {
        let mut store = store_with_seed([7u8; 32]);

        let accepted = call(
            &mut store,
            br#"{"cmd":"signParent","seq":1,"userId":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
        );
        assert!(is_ok(&accepted), "unexpected response: {accepted}");
        assert_eq!(
            store.secrets.get(PARENT_NEXTSEQ_KEY).cloned(),
            Some(2u64.to_le_bytes().to_vec())
        );

        let replay = call(&mut store, br#"{"cmd":"signParent","seq":1,"userId":null}"#);
        assert!(!is_ok(&replay));
        assert!(error_text(&replay).contains("stale"));

        let zero = call(&mut store, br#"{"cmd":"signParent","seq":0,"userId":null}"#);
        assert!(!is_ok(&zero));
        assert!(error_text(&zero).contains("greater than 0"));

        let max = call(
            &mut store,
            br#"{"cmd":"signParent","seq":18446744073709551615,"userId":null}"#,
        );
        assert!(!is_ok(&max));
        assert!(error_text(&max).contains("too large"));

        let cleared = call(&mut store, br#"{"cmd":"signParent","seq":2,"userId":null}"#);
        assert!(is_ok(&cleared), "unexpected response: {cleared}");

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["parentNextSeq"], 3);
    }

    #[test]
    fn sign_parent_rejects_self_parent_and_malformed_user_ids() {
        let mut store = store_with_seed([7u8; 32]);

        let self_parent = format!(r#"{{"cmd":"signParent","seq":1,"userId":"{GOLDEN_PUBKEY}"}}"#);
        let response = call(&mut store, self_parent.as_bytes());
        assert!(!is_ok(&response));
        assert!(error_text(&response).contains("self-parent"));
        assert_eq!(
            store.secrets.get(PARENT_NEXTSEQ_KEY),
            None,
            "a rejected self-parent must not advance the counter"
        );

        for bad in [
            String::new(),
            "11".to_string(),
            "11".repeat(31),
            "11".repeat(33),
        ] {
            let payload = serde_json::json!({
                "cmd": "signParent",
                "seq": 1,
                "userId": bad,
            })
            .to_string();
            let response = call(&mut store, payload.as_bytes());
            assert!(!is_ok(&response), "userId {bad:?} must be rejected");
            assert!(error_text(&response).contains("userId"));
        }

        let uppercase = format!(
            r#"{{"cmd":"signParent","seq":1,"userId":"{}"}}"#,
            "aa".repeat(32).to_uppercase()
        );
        let response = call(&mut store, uppercase.as_bytes());
        assert!(!is_ok(&response));
        assert!(error_text(&response).contains("userId"));
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
    fn contacts_seq_is_monotonic_and_empty_list_is_a_tombstone() {
        let mut store = store_with_seed([7u8; 32]);

        let accepted = call(
            &mut store,
            br#"{"cmd":"signContacts","seq":5,"entries":[{"label":"Alice","userId":"1111111111111111111111111111111111111111111111111111111111111111"}]}"#,
        );
        assert!(is_ok(&accepted), "unexpected response: {accepted}");
        assert_eq!(
            store.secrets.get(CONTACTS_NEXTSEQ_KEY).cloned(),
            Some(6u64.to_le_bytes().to_vec())
        );

        let replay = call(
            &mut store,
            br#"{"cmd":"signContacts","seq":5,"entries":[]}"#,
        );
        assert!(!is_ok(&replay));
        assert!(error_text(&replay).contains("stale"));

        // An empty list at a fresh seq is a legal tombstone.
        let tombstone = call(
            &mut store,
            br#"{"cmd":"signContacts","seq":6,"entries":[]}"#,
        );
        assert!(is_ok(&tombstone), "unexpected response: {tombstone}");

        let identity = call(&mut store, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["contactsNextSeq"], 7);
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
            contact: CONTACT_11.into(),
            unit: Some("u".repeat(MAX_UNIT_BYTES)),
            note: Some("n".repeat(MAX_NOTE_BYTES)),
        };
        assert!(sign_with(&mut store, 0, 1, Some(&max_entry)).is_ok());

        let too_long = |entry: Entry| {
            let mut fresh = store_with_seed([7u8; 32]);
            sign_with(&mut fresh, 0, 1, Some(&entry)).expect_err("metadata bound must reject")
        };

        let contact_error = too_long(Entry {
            value: 0,
            contact: "11".repeat(31),
            unit: None,
            note: None,
        });
        assert!(contact_error.contains("contact"));

        let unit_error = too_long(Entry {
            value: 0,
            contact: CONTACT_11.into(),
            unit: Some("u".repeat(MAX_UNIT_BYTES + 1)),
            note: None,
        });
        assert!(unit_error.contains("unit"));

        let note_error = too_long(Entry {
            value: 0,
            contact: CONTACT_11.into(),
            unit: None,
            note: Some("n".repeat(MAX_NOTE_BYTES + 1)),
        });
        assert!(note_error.contains("note"));

        // Bounds are bytes, not characters: 9 two-byte characters is 18 bytes.
        let multibyte_error = too_long(Entry {
            value: 0,
            contact: CONTACT_11.into(),
            unit: Some("é".repeat(MAX_UNIT_BYTES / 2 + 1)),
            note: None,
        });
        assert!(multibyte_error.contains("unit"));
    }

    #[test]
    fn contacts_bounds_are_enforced() {
        let cases: Vec<(Vec<Contact>, &str)> = vec![
            (vec![contact("", CONTACT_11)], "must not be empty"),
            (
                vec![contact(
                    &"l".repeat(MAX_CONTACT_LABEL_BYTES + 1),
                    CONTACT_11,
                )],
                "label",
            ),
            (vec![contact("Alice", "")], "userId"),
            (vec![contact("Alice", &"11".repeat(31))], "userId"),
            (vec![contact("Alice", &("11".repeat(31) + "AA"))], "userId"),
            (
                vec![contact("Alice", CONTACT_11), contact("Alicia", CONTACT_11)],
                "duplicates a userId",
            ),
            (
                vec![contact("Alice", CONTACT_11), contact("Alice", CONTACT_22)],
                "duplicates a label",
            ),
        ];

        for (entries, expected) in cases {
            let mut store = MemoryStore::default();
            let error = sign_contacts_with(&mut store, 1, &entries)
                .expect_err("invalid contact list must be rejected");
            assert!(
                error.contains(expected),
                "error {error:?} did not contain {expected:?}"
            );
            assert!(
                store.secrets.is_empty(),
                "an invalid contact list must not create a seed"
            );
        }

        let mut store = store_with_seed([7u8; 32]);
        let too_many: Vec<Contact> = (0..=MAX_CONTACTS)
            .map(|index| {
                let mut user_id = [1u8; 32];
                user_id[31] = index as u8;
                contact(&format!("c{index}"), &hex::encode(user_id))
            })
            .collect();
        let error = sign_contacts_with(&mut store, 1, &too_many).expect_err("65 contacts rejected");
        assert!(error.contains("maximum"));

        let at_limit: Vec<Contact> = (0..MAX_CONTACTS)
            .map(|index| {
                let mut user_id = [1u8; 32];
                user_id[31] = index as u8;
                contact(&format!("c{index}"), &hex::encode(user_id))
            })
            .collect();
        assert!(sign_contacts_with(&mut store, 1, &at_limit).is_ok());

        let zero = sign_contacts_with(&mut store, 0, &[]).expect_err("seq must be positive");
        assert!(zero.contains("seq"));
    }

    #[test]
    fn unpinned_origins_are_refused_without_touching_secrets() {
        let payload = br#"{"cmd":"identity"}"#;
        let expected = expected_webapp_id();
        let delegate =
            MessageOrigin::Delegate(DelegateKey::new([9u8; 32], CodeHash::new([8u8; 32])));
        let foreign_webapp = MessageOrigin::WebApp(ContractInstanceId::new([0x43; 32]));

        for (label, origin) in [
            ("missing", None),
            ("delegate", Some(&delegate)),
            ("foreign webapp", Some(&foreign_webapp)),
        ] {
            let mut store = MemoryStore::default();
            let bytes = handle_application_message(&mut store, expected, origin, payload);
            let response: Value = serde_json::from_slice(&bytes).unwrap();

            assert!(!is_ok(&response), "{label} origin must be refused");
            assert!(error_text(&response).contains("refused"));
            assert!(
                store.secrets.is_empty(),
                "{label} origin must not create a seed"
            );
        }

        let mut store = MemoryStore::default();
        let origin = webapp_origin(expected);
        let bytes = handle_application_message(&mut store, expected, Some(&origin), payload);
        let response: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(is_ok(&response), "pinned web app origin must be accepted");
    }

    #[test]
    fn delegate_parameters_must_be_the_pinned_webapp_id() {
        for length in [0, 31, 33] {
            let params = Parameters::from(vec![0u8; length]);
            assert!(
                expected_webapp(&params).is_err(),
                "params of {length} bytes must be refused"
            );
        }

        let params = Parameters::from(vec![7u8; WEBAPP_ID_LEN]);
        assert_eq!(
            expected_webapp(&params).expect("32-byte params are valid"),
            ContractInstanceId::new([7u8; WEBAPP_ID_LEN])
        );
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
            br#"{"cmd":"signContacts","seq":1,"entries":{}}"#,
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

        let mut contacts_store = store_with_seed([7u8; 32]);
        assert!(contacts_store.set_secret(CONTACTS_NEXTSEQ_KEY, &[1, 2, 3]));
        let identity = call(&mut contacts_store, br#"{"cmd":"identity"}"#);
        assert!(!is_ok(&identity));
        assert!(error_text(&identity).contains("invalid length"));

        let mut parent_store = store_with_seed([7u8; 32]);
        assert!(parent_store.set_secret(PARENT_NEXTSEQ_KEY, &[1, 2, 3]));
        let identity = call(&mut parent_store, br#"{"cmd":"identity"}"#);
        assert!(!is_ok(&identity));
        assert!(error_text(&identity).contains("invalid length"));

        let mut payments_store = store_with_seed([7u8; 32]);
        assert!(payments_store.set_secret(PAYMENTS_NEXTSEQ_KEY, &[1, 2, 3]));
        let identity = call(&mut payments_store, br#"{"cmd":"identity"}"#);
        assert!(!is_ok(&identity));
        assert!(error_text(&identity).contains("invalid length"));
    }

    fn base58_hash(bytes: [u8; 32]) -> String {
        bs58::encode(bytes)
            .with_alphabet(bs58::Alphabet::BITCOIN)
            .into_string()
    }

    fn empty_state_bytes(v: u8) -> Vec<u8> {
        let slots: Vec<Value> = (0..SLOT_COUNT)
            .map(|_| json!({"seq": 0, "entry": null, "sig": null}))
            .collect();
        serde_json::to_vec(&json!({
            "v": v,
            "parent": {"seq": 0, "userId": null, "sig": null},
            "contacts": {"seq": 0, "entries": [], "sig": null},
            "payments": {"seq": 0, "settled": [], "entry": null, "sig": null},
            "adjustments": {"seq": 0, "entries": [], "sig": null},
            "slots": slots,
        }))
        .expect("state serializes")
    }

    fn state_with_payments_seq(v: u8, seq: u64) -> Vec<u8> {
        let mut value: Value = serde_json::from_slice(&empty_state_bytes(v)).expect("state parses");
        value["payments"]["seq"] = seq.into();
        serde_json::to_vec(&value).expect("state serializes")
    }

    #[test]
    fn resolve_owner_prefers_local_state_over_a_stale_notification_cache() {
        let seed = [7u8; 32];
        let mut host = store_with_seed(seed);
        let owner_bytes = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let owner = hex::encode(owner_bytes);
        let hash = [0xAAu8; 32];
        let instance = derive_instance_id(&hash, &owner_bytes);

        let stale = state_with_payments_seq(5, 1);
        let current = state_with_payments_seq(5, 2);
        host.contracts.insert(instance.to_vec(), current);

        let mut inbox = InboxState::default();
        inbox.instances.insert(
            hex::encode(instance),
            InstanceRecord {
                state: "known".to_owned(),
                seq: 1,
                owner: Some(owner.clone()),
                data: Some(hex::encode(&stale)),
                retry_next_wake: false,
            },
        );

        let mut out = Vec::new();
        let resolved = resolve_owner(&mut host, &[hash], &owner, &mut inbox, &mut out)
            .expect("local state resolves");
        assert_eq!(
            resolved.state.expect("state is present").payments.seq,
            2,
            "the committed local state must beat a stale notification cache"
        );
        assert!(out.is_empty(), "a local hit must not issue a network GET");
        assert_eq!(inbox.instances[&hex::encode(instance)].seq, 2);
    }

    #[test]
    fn resolve_owner_prefers_a_fresher_notification_cache() {
        let seed = [7u8; 32];
        let mut host = store_with_seed(seed);
        let owner_bytes = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let owner = hex::encode(owner_bytes);
        let hash = [0xAAu8; 32];
        let instance = derive_instance_id(&hash, &owner_bytes);

        // The committed copy is behind: a GET/notification already saw the
        // newer payment record. The cache must win.
        let stale = state_with_payments_seq(5, 1);
        let current = state_with_payments_seq(5, 2);
        host.contracts.insert(instance.to_vec(), stale);

        let mut inbox = InboxState::default();
        inbox.instances.insert(
            hex::encode(instance),
            InstanceRecord {
                state: "known".to_owned(),
                seq: 1,
                owner: Some(owner.clone()),
                data: Some(hex::encode(&current)),
                retry_next_wake: false,
            },
        );

        let mut out = Vec::new();
        let resolved = resolve_owner(&mut host, &[hash], &owner, &mut inbox, &mut out)
            .expect("cached state resolves");
        assert_eq!(
            resolved.state.expect("state is present").payments.seq,
            2,
            "the newer payment record must win even when it is in the cache"
        );
        assert!(out.is_empty(), "a resolved hit must not issue a network GET");
        assert_eq!(inbox.instances[&hex::encode(instance)].seq, 2);
    }

    #[test]
    fn a_busy_plan_requests_a_get_for_the_own_board() {
        let own = [0xAB; 32];
        let mut inbox = InboxState {
            budget: MAX_NETWORK_OPS,
            ..Default::default()
        };
        let mut out = Vec::new();

        assert!(!request_own_refresh_on_busy(
            &mut inbox,
            own,
            AdvanceError::Negative,
            &mut out
        ));
        assert!(out.is_empty(), "only Busy is a refresh signal");

        assert!(request_own_refresh_on_busy(
            &mut inbox,
            own,
            AdvanceError::Busy,
            &mut out
        ));
        assert_eq!(out.len(), 1, "Busy must request the own board");
        match &out[0] {
            OutboundDelegateMsg::GetContractRequest(request) => {
                assert_eq!(request.contract_id.as_bytes(), &own);
            }
            other => panic!("unexpected outbound: {other:?}"),
        }
        assert_eq!(inbox.instances[&hex::encode(own)].state, "requested");

        // The request is already in flight; do not issue a second one.
        let mut out = Vec::new();
        assert!(request_own_refresh_on_busy(
            &mut inbox,
            own,
            AdvanceError::Busy,
            &mut out
        ));
        assert!(out.is_empty());
    }

    #[test]
    fn manifest_requests_background_wakeups_for_the_inbox() {
        let manifest = NumberDelegate::__FREENET_DELEGATE_MANIFEST_JSON;
        assert!(
            manifest.contains("\"lifecycle\":[\"node_started\"]"),
            "{manifest}"
        );
        assert!(
            manifest.contains("\"capabilities\":[\"background\"]"),
            "{manifest}"
        );
        assert!(manifest.contains("\"tag\":\"inbox\""), "{manifest}");
        assert!(manifest.contains("\"every_secs\":300"), "{manifest}");
    }

    #[test]
    fn configure_accepts_all_four_fields_and_acks_bare_ok() {
        let mut store = store_with_seed([7u8; 32]);
        let hash = base58_hash([0xAA; 32]);
        let payload = json!({
            "cmd": "configure",
            "codeHashes": [hash],
            "address": "52",
            "autoAdvance": false,
            "maxAmount": 4242,
        });
        let response = call(&mut store, payload.to_string().as_bytes());

        assert_eq!(response, json!({"ok": true}));
        assert!(store.secrets.contains_key(CONFIG_KEY));

        let status = call(&mut store, br#"{"cmd":"status"}"#);
        assert!(is_ok(&status), "unexpected status: {status}");
        assert_eq!(status["configured"], true);
        assert_eq!(status["codeHashes"], json!([base58_hash([0xAA; 32])]));
        assert_eq!(status["address"], "52");
        assert_eq!(status["autoAdvance"], false);
        assert_eq!(status["maxAmount"], 4242);
        assert_eq!(status["matchedCodeHash"], Value::Null);
        assert_eq!(status["subscriptions"], json!([]));
        assert_eq!(status["lastScan"], 0);
        assert_eq!(status["lastError"], Value::Null);
        assert_eq!(status["audit"], json!([]));
    }

    #[test]
    fn status_includes_v8_defaults_before_configure() {
        let mut store = store_with_seed([7u8; 32]);
        let status = call(&mut store, br#"{"cmd":"status"}"#);

        assert!(is_ok(&status), "unexpected status: {status}");
        assert_eq!(status["configured"], false);
        assert_eq!(status["codeHashes"], json!([]));
        assert_eq!(status["matchedCodeHash"], Value::Null);
        assert_eq!(status["address"], "");
        assert_eq!(status["autoAdvance"], true);
        assert_eq!(status["maxAmount"], DEFAULT_MAX_AMOUNT);
        assert_eq!(status["subscriptions"], json!([]));
        assert_eq!(status["lastScan"], 0);
        assert_eq!(status["lastError"], Value::Null);
        assert_eq!(status["audit"], json!([]));
    }

    #[test]
    fn configure_rejects_hex_hashes_bad_addresses_and_negative_caps() {
        let mut store = store_with_seed([7u8; 32]);

        let hex = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": ["aa".repeat(32)],
                "address": "52",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(!is_ok(&hex));
        assert!(error_text(&hex).contains("base58"));

        let address = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash([0xAA; 32])],
                "address": "58",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(!is_ok(&address));
        assert!(error_text(&address).contains("octal"));

        let cap = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash([0xAA; 32])],
                "address": "52",
                "maxAmount": -1,
            })
            .to_string()
            .as_bytes(),
        );
        assert!(!is_ok(&cap));
        assert!(error_text(&cap).contains("maxAmount"));
    }

    #[test]
    fn configure_requires_an_existing_identity() {
        let mut store = MemoryStore::default();
        let response = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash([0xAA; 32])],
                "address": "52",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(!is_ok(&response));
        assert!(error_text(&response).contains("seed"));
        assert!(store.secrets.is_empty(), "configure must not mint a seed");
    }

    #[test]
    fn instance_ids_are_blake3_of_raw_hash_and_owner() {
        let hash = [0xAA; 32];
        let owner = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        let mut hasher = blake3::Hasher::new();
        hasher.update(&hash);
        hasher.update(&owner);
        assert_eq!(
            derive_instance_id(&hash, &owner),
            *hasher.finalize().as_bytes()
        );
    }

    #[test]
    fn set_auto_advance_changes_policy_and_cap() {
        let mut store = store_with_seed([7u8; 32]);
        let configured = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash([0xAA; 32])],
                "address": "52",
                "autoAdvance": true,
                "maxAmount": DEFAULT_MAX_AMOUNT,
            })
            .to_string()
            .as_bytes(),
        );
        assert_eq!(configured, json!({"ok": true}));

        let changed = call(
            &mut store,
            br#"{"cmd":"setAutoAdvance","enabled":false,"maxAmount":42}"#,
        );
        assert_eq!(changed, json!({"ok": true}));

        let status = call(&mut store, br#"{"cmd":"status"}"#);
        assert_eq!(status["autoAdvance"], false);
        assert_eq!(status["maxAmount"], 42);

        let missing = call(
            &mut MemoryStore::default(),
            br#"{"cmd":"setAutoAdvance","enabled":true}"#,
        );
        assert!(!is_ok(&missing));
        assert!(error_text(&missing).contains("not configured"));
    }

    #[test]
    fn sign_adjustment_vector_persists_the_counter_and_imports_default_to_one() {
        let mut store = store_with_seed([7u8; 32]);
        let entries = vec![Adjustment {
            slot: 1,
            slot_seq: 4,
            delta: 100,
            post_value: 3750,
            note: Some("issue".into()),
        }];
        let payload = json!({"cmd": "signAdjustment", "seq": 1, "entries": entries}).to_string();
        let response = call(&mut store, payload.as_bytes());

        assert!(is_ok(&response), "unexpected response: {response}");
        assert_eq!(response["seq"], 1);
        let expected =
            SigningKey::from_bytes(&[7u8; 32]).sign(&adjustments_signing_bytes(1, &entries));
        assert_eq!(response["sig"], hex::encode(expected.to_bytes()));
        assert_eq!(
            store.secrets.get(ADJUSTMENTS_NEXTSEQ_KEY).cloned(),
            Some(2u64.to_le_bytes().to_vec())
        );

        let replay = call(&mut store, payload.as_bytes());
        assert!(!is_ok(&replay));
        assert!(error_text(&replay).contains("stale"));

        let export = call(&mut store, br#"{"cmd":"export"}"#);
        assert_eq!(export["adjustmentsNextSeq"], 2);

        let mut fresh = MemoryStore::default();
        let import = format!(
            r#"{{"cmd":"import","seed":"{}","nextSeq":[1,1,1,1,1,1,1,1]}}"#,
            "07".repeat(32)
        );
        let imported = call(&mut fresh, import.as_bytes());
        assert!(is_ok(&imported));
        let identity = call(&mut fresh, br#"{"cmd":"identity"}"#);
        assert_eq!(identity["adjustmentsNextSeq"], 1);
    }

    #[test]
    fn sign_adjustment_rejects_invalid_records() {
        let cases = [
            (
                Adjustment {
                    slot: 8,
                    slot_seq: 1,
                    delta: 1,
                    post_value: 1,
                    note: None,
                },
                "slot",
            ),
            (
                Adjustment {
                    slot: 0,
                    slot_seq: 0,
                    delta: 1,
                    post_value: 1,
                    note: None,
                },
                "slotSeq",
            ),
            (
                Adjustment {
                    slot: 0,
                    slot_seq: 1,
                    delta: 0,
                    post_value: 1,
                    note: None,
                },
                "delta",
            ),
            (
                Adjustment {
                    slot: 0,
                    slot_seq: 1,
                    delta: 1,
                    post_value: -1,
                    note: None,
                },
                "postValue",
            ),
            (
                Adjustment {
                    slot: 0,
                    slot_seq: 1,
                    delta: 10,
                    post_value: 5,
                    note: None,
                },
                "pre-value",
            ),
            (
                Adjustment {
                    slot: 0,
                    slot_seq: 1,
                    delta: 1,
                    post_value: 1,
                    note: Some("n".repeat(MAX_ADJUSTMENT_NOTE_BYTES + 1)),
                },
                "note",
            ),
        ];
        for (entry, expected) in cases {
            let mut store = store_with_seed([7u8; 32]);
            let error = sign_adjustment_with(&mut store, 1, &[entry])
                .expect_err("invalid adjustment must be rejected");
            assert!(
                error.contains(expected),
                "error {error:?} did not contain {expected:?}"
            );
            assert!(
                !store.secrets.contains_key(ADJUSTMENTS_NEXTSEQ_KEY),
                "a rejected adjustment must not advance the counter"
            );
        }

        let mut store = store_with_seed([7u8; 32]);
        let duplicate = vec![
            Adjustment {
                slot: 0,
                slot_seq: 1,
                delta: 1,
                post_value: 1,
                note: None,
            },
            Adjustment {
                slot: 0,
                slot_seq: 1,
                delta: 1,
                post_value: 2,
                note: None,
            },
        ];
        assert!(
            sign_adjustment_with(&mut store, 1, &duplicate)
                .expect_err("duplicate must be rejected")
                .contains("duplicates")
        );

        let decreasing = vec![
            Adjustment {
                slot: 0,
                slot_seq: 2,
                delta: 1,
                post_value: 1,
                note: None,
            },
            Adjustment {
                slot: 0,
                slot_seq: 1,
                delta: 1,
                post_value: 2,
                note: None,
            },
        ];
        assert!(
            sign_adjustment_with(&mut store, 1, &decreasing)
                .expect_err("decreasing slotSeq must be rejected")
                .contains("increase")
        );
    }

    #[test]
    fn wakeup_subscribes_to_the_own_instance_and_respects_the_budget() {
        let mut store = store_with_seed([7u8; 32]);
        let hash = [0xAA; 32];
        let configured = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash(hash)],
                "address": "",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(is_ok(&configured));
        let owner = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        let own = derive_instance_id(&hash, &owner);
        store.contracts.insert(own.to_vec(), empty_state_bytes(4));

        let out = handle_background(
            &mut store,
            InboundDelegateMsg::WakeupFired {
                tag: b"inbox".to_vec(),
            },
        );
        assert_eq!(out.len(), 1, "one bootstrap subscribe");
        match &out[0] {
            OutboundDelegateMsg::SubscribeContractRequest(request) => {
                assert_eq!(request.contract_id.as_bytes(), &own);
            }
            other => panic!("unexpected outbound: {other:?}"),
        }

        let inbox = load_inbox(&store).expect("inbox reads");
        assert_eq!(inbox.budget_reset, "wakeup");
        assert_eq!(inbox.budget, MAX_NETWORK_OPS - 1);
        assert_eq!(inbox.matched_code_hash, Some(base58_hash(hash)));
        let subscriptions = load_subscriptions(&store).expect("subscriptions read");
        assert_eq!(subscriptions.subscribed, vec![hex::encode(own)]);

        // NodeStarted re-subscribes own + parent unconditionally.
        let out = handle_background(
            &mut store,
            InboundDelegateMsg::Lifecycle(LifecycleEvent::NodeStarted {
                down_since_ms: None,
            }),
        );
        assert_eq!(out.len(), 1);
        match &out[0] {
            OutboundDelegateMsg::SubscribeContractRequest(request) => {
                assert_eq!(request.contract_id.as_bytes(), &own);
            }
            other => panic!("unexpected outbound: {other:?}"),
        }
    }

    #[test]
    fn a_missing_get_response_is_retried_on_the_next_wake_not_immediately() {
        let mut store = store_with_seed([7u8; 32]);
        let hash = [0xAA; 32];
        let configured = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash(hash)],
                "address": "",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(is_ok(&configured));
        let owner = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        let own = derive_instance_id(&hash, &owner);

        let out = handle_background(
            &mut store,
            InboundDelegateMsg::WakeupFired {
                tag: b"inbox".to_vec(),
            },
        );
        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            OutboundDelegateMsg::GetContractRequest(request)
                if request.contract_id.as_bytes() == own.as_slice()
        ));
        let inbox = load_inbox(&store).unwrap();
        assert_eq!(inbox.instances[&hex::encode(own)].state, "requested");

        // A None state is ambiguous: mark unknown, do not re-issue in this pass.
        let out = handle_background(
            &mut store,
            InboundDelegateMsg::GetContractResponse(GetContractResponse {
                contract_id: ContractInstanceId::new(own),
                state: None,
                context: DelegateContext::default(),
            }),
        );
        assert!(
            out.is_empty(),
            "must not retry within the same response pass"
        );

        // The next wake resets the retry guard and asks again.
        let out = handle_background(
            &mut store,
            InboundDelegateMsg::WakeupFired {
                tag: b"inbox".to_vec(),
            },
        );
        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            OutboundDelegateMsg::GetContractRequest(request)
                if request.contract_id.as_bytes() == own.as_slice()
        ));
    }

    #[test]
    fn resolving_only_at_a_legacy_hash_refuses_auto_advance() {
        let mut store = store_with_seed([7u8; 32]);
        let active = [0xAA; 32];
        let legacy = [0xBB; 32];
        let configured = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash(active), base58_hash(legacy)],
                "address": "",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(is_ok(&configured));
        let owner = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        let legacy_instance = derive_instance_id(&legacy, &owner);
        store
            .contracts
            .insert(legacy_instance.to_vec(), empty_state_bytes(4));

        let _ = handle_background(
            &mut store,
            InboundDelegateMsg::WakeupFired {
                tag: b"inbox".to_vec(),
            },
        );
        let inbox = load_inbox(&store).unwrap();
        assert_eq!(inbox.last_error.as_deref(), Some("mixed-version"));
        assert_eq!(
            inbox.matched_code_hash.as_deref(),
            Some(base58_hash(legacy).as_str())
        );
    }

    #[test]
    fn a_contract_notification_marks_the_instance_known() {
        let mut store = store_with_seed([7u8; 32]);
        let hash = [0xAA; 32];
        let configured = call(
            &mut store,
            json!({
                "cmd": "configure",
                "codeHashes": [base58_hash(hash)],
                "address": "",
            })
            .to_string()
            .as_bytes(),
        );
        assert!(is_ok(&configured));
        let owner = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        let own = derive_instance_id(&hash, &owner);

        let _out = handle_background(
            &mut store,
            InboundDelegateMsg::ContractNotification(ContractNotification {
                contract_id: ContractInstanceId::new(own),
                new_state: WrappedState::new(empty_state_bytes(4)),
                context: DelegateContext::default(),
            }),
        );
        let inbox = load_inbox(&store).unwrap();
        assert_eq!(inbox.instances[&hex::encode(own)].state, "known");
    }

    proptest! {
        #[test]
        fn entry_json_round_trip_preserves_signing_bytes(
            value in any::<i64>(),
            contact_bytes in proptest::array::uniform32(any::<u8>()),
            unit in proptest::option::of("[A-Za-z0-9 _-]{0,16}"),
            note in proptest::option::of("[A-Za-z0-9 _-]{0,512}"),
        ) {
            let entry = Entry {
                value,
                contact: hex::encode(contact_bytes),
                unit,
                note,
            };
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
