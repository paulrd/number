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
pub const DELEGATE_VERSION: u32 = 7;

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
}

/// `{"ok":true}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportResponse {
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
    Status(StatusResponse),
    Export(ExportResponse),
    Import(ImportResponse),
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
            _ => Err(DelegateError::Other("unexpected message type".into())),
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
            Ok((pubkey, next_seq, contacts_next_seq, parent_next_seq, payments_next_seq)) => {
                Response::Identity(IdentityResponse {
                    ok: true,
                    pubkey,
                    next_seq,
                    contacts_next_seq,
                    parent_next_seq,
                    payments_next_seq,
                })
            }
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
        Request::Status => match status_with(store) {
            Ok(response) => Response::Status(response),
            Err(error) => Response::error(error),
        },
        Request::Export => match export_with(store) {
            Ok((seed, next_seq, contacts_next_seq, parent_next_seq, payments_next_seq)) => {
                Response::Export(ExportResponse {
                    ok: true,
                    version: DELEGATE_VERSION,
                    seed,
                    next_seq,
                    contacts_next_seq,
                    parent_next_seq,
                    payments_next_seq,
                })
            }
            Err(error) => Response::error(error),
        },
        Request::Import {
            seed,
            next_seq,
            contacts_next_seq,
            parent_next_seq,
            payments_next_seq,
        } => match import_with(
            store,
            &seed,
            &next_seq,
            contacts_next_seq,
            parent_next_seq,
            payments_next_seq,
        ) {
            Ok(()) => Response::Import(ImportResponse { ok: true }),
            Err(error) => Response::error(error),
        },
    }
}

/// Return `(hex public key, nextSeq[0..8], contactsNextSeq, parentNextSeq,
/// paymentsNextSeq)`, creating the seed on first use.
pub fn identity_with(
    store: &mut impl SecretStore,
) -> Result<(String, [u64; SLOT_COUNT], u64, u64, u64), String> {
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

    Ok((
        pubkey,
        next_seq,
        contacts_next_seq,
        parent_next_seq,
        payments_next_seq,
    ))
}

/// Report whether a seed exists, without creating one.
///
/// The UI calls this before `identity` so a fresh delegate can be offered a
/// predecessor's exported seed first. `identity` would otherwise create a new
/// seed and make the migration impossible.
pub fn status_with(store: &impl SecretStore) -> Result<StatusResponse, String> {
    let Some(bytes) = store.get_secret(SECRET_SEED) else {
        return Ok(StatusResponse {
            ok: true,
            version: DELEGATE_VERSION,
            has_seed: false,
            pubkey: None,
            next_seq: None,
            contacts_next_seq: None,
            parent_next_seq: None,
            payments_next_seq: None,
        });
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

    Ok(StatusResponse {
        ok: true,
        version: DELEGATE_VERSION,
        has_seed: true,
        pubkey: Some(pubkey),
        next_seq: Some(next_seq),
        contacts_next_seq: Some(contacts_next_seq),
        parent_next_seq: Some(parent_next_seq),
        payments_next_seq: Some(payments_next_seq),
    })
}

/// Export the owner seed and counters for a successor delegate.
///
/// Authorization is the same pinned-webapp gate as every other request. This
/// is the forward-only migration path: a successor can only recover from a
/// predecessor whose already-published WASM answers this command.
pub fn export_with(
    store: &impl SecretStore,
) -> Result<(String, [u64; SLOT_COUNT], u64, u64, u64), String> {
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

    Ok((
        hex::encode(seed),
        next_seq,
        contacts_next_seq,
        parent_next_seq,
        payments_next_seq,
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
