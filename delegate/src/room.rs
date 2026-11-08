//! Canonical room signing bytes and request validation.
//!
//! This mirrors `DESIGN-rooms.md` §3 and `DESIGN-candidates.md` §3 inside the
//! delegate crate. It is a deliberate duplicate of the `room` and `candidate`
//! crate encoders: the delegate builds to its own WASM, and a path dependency
//! on either contract crate would pull its dependency graph into the delegate
//! artifact, re-keying it unpredictably. The implementations are held together
//! by the shared golden fixtures (`fixtures/rooms/golden_v1.json` and
//! `fixtures/candidate/golden_v1.json`) and must be changed together.
//!
//! The delegate signs records for both room kinds: the members room (`ZMR1`)
//! and the candidate room (`ZCR1`). Each contract still accepts only its own
//! tag; only the delegate accepts both. Membership and message signing bytes
//! carry the caller's tag, while the three candidate-only records are always
//! bound to `ZCR1`.
//!
//! The delegate signs records on behalf of the web UI; it does not store room
//! state. Only the per-room sequence counters live in the delegate's secret
//! store (see `lib.rs`).

use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

/// The members-room tag.
pub const ROOM_TAG: &str = "ZMR1";

/// The candidate-room tag.
pub const CANDIDATE_TAG: &str = "ZCR1";

/// Domain separator for membership signing bytes (`DESIGN-rooms.md` §3).
pub const SIGNING_DOMAIN_MEMBERSHIP: &[u8] = b"number:v1:room:membership";

/// Domain separator for message signing bytes (`DESIGN-rooms.md` §3).
pub const SIGNING_DOMAIN_MESSAGE: &[u8] = b"number:v1:room:message";

/// Domain separator for candidate request signing bytes
/// (`DESIGN-candidates.md` §3).
pub const SIGNING_DOMAIN_REQUEST: &[u8] = b"number:v1:candidate:request";

/// Domain separator for candidate request-dismissal signing bytes
/// (`DESIGN-candidates.md` §3).
pub const SIGNING_DOMAIN_DISMISS: &[u8] = b"number:v1:candidate:dismiss";

/// Domain separator for candidate config signing bytes
/// (`DESIGN-candidates.md` §3).
pub const SIGNING_DOMAIN_CONFIG: &[u8] = b"number:v1:candidate:config";

/// Maximum members in a members room (owner + eight slots).
pub const MAX_MEMBERS: usize = 9;
/// Maximum decoded length of one epoch-secret blob.
pub const MAX_SECRET_BLOB_BYTES: usize = 256;
/// Maximum decoded length of a message body in bytes.
pub const MAX_BODY_BYTES: usize = 1024;
/// Maximum number of characters in a candidate request's `want_cell`.
pub const MAX_WANT_CELL_CHARS: usize = 32;
/// Maximum decoded length of a candidate request note in bytes.
pub const MAX_NOTE_BYTES: usize = 256;

const KEY_HEX_LEN: usize = 64;
const REQUEST_ID_HEX_LEN: usize = 32;

/// One epoch secret: a blob encrypted for `recipient`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomSecret {
    /// Recipient key, 64 lowercase hex characters.
    pub recipient: String,
    /// Ciphertext blob as lowercase hex, 1..=256 decoded bytes.
    pub blob: String,
}

/// Reject anything but the two room kinds the delegate signs for.
pub fn validate_tag(tag: &str) -> Result<(), String> {
    if tag == ROOM_TAG || tag == CANDIDATE_TAG {
        Ok(())
    } else {
        Err(format!(
            "room tag must be exactly {ROOM_TAG:?} or {CANDIDATE_TAG:?}; {tag:?} is not accepted"
        ))
    }
}

/// The four ASCII bytes of a validated room tag, for tag-bound crypto.
pub fn tag_bytes(tag: &str) -> Result<[u8; 4], String> {
    validate_tag(tag)?;
    tag.as_bytes()
        .try_into()
        .map_err(|_| format!("room tag {tag:?} must be four bytes"))
}

/// Decode a base58 room id into exactly 32 raw bytes.
pub fn decode_room_id(room_id: &str) -> Result<[u8; 32], String> {
    let bytes = bs58::decode(room_id)
        .into_vec()
        .map_err(|error| format!("roomId is not valid base58: {error}"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("roomId must decode to 32 bytes, got {}", bytes.len()))
}

/// Validate a 64-lowercase-hex Ed25519 point.
pub fn validate_key(field: &str, value: &str) -> Result<(), String> {
    if !is_lower_hex(value, KEY_HEX_LEN) {
        return Err(format!(
            "{field} must be exactly {KEY_HEX_LEN} lowercase hex characters"
        ));
    }
    let raw = decode_exact::<32>(field, value)?;
    VerifyingKey::from_bytes(&raw).map_err(|_| format!("{field} is not a valid Ed25519 point"))?;
    Ok(())
}

/// Validate and decode a 64-lowercase-hex Ed25519 point to its 32 raw bytes.
pub fn decode_key(field: &str, value: &str) -> Result<[u8; 32], String> {
    validate_key(field, value)?;
    decode_exact::<32>(field, value)
}

/// Validate the membership invariants before signing. The caller separately
/// checks that `owner` is the local delegate key (the owner-only rule).
pub fn membership_error(
    owner: &str,
    seq: u64,
    members: &[String],
    secrets: &[RoomSecret],
) -> Result<(), String> {
    if seq == 0 {
        return Err("room membership seq must be greater than 0".into());
    }
    if members.is_empty() {
        return Err("room membership must include at least the owner".into());
    }
    if members.len() > MAX_MEMBERS {
        return Err(format!(
            "room membership has {} members; maximum is {MAX_MEMBERS}",
            members.len()
        ));
    }

    let mut previous: Option<&str> = None;
    for (index, member) in members.iter().enumerate() {
        validate_key(&format!("room membership member {index}"), member)?;
        if let Some(previous) = previous {
            if member.as_str() <= previous {
                return Err(format!(
                    "room membership member {index} must be strictly ascending and unique"
                ));
            }
        }
        previous = Some(member.as_str());
    }

    if !members.iter().any(|member| member == owner) {
        return Err("room membership must include the owner key".into());
    }

    if !secrets.is_empty() {
        if secrets.len() != members.len() {
            return Err(format!(
                "room membership has {} secrets for {} members; secrets must be empty or exactly one per member",
                secrets.len(),
                members.len()
            ));
        }
        for (index, secret) in secrets.iter().enumerate() {
            if secret.recipient != members[index] {
                return Err(format!(
                    "room membership secret {index} recipient must match member {index}"
                ));
            }
            match decoded_lower_hex_len(&secret.blob) {
                None => {
                    return Err(format!(
                        "room membership secret {index} blob must be lowercase hex"
                    ));
                }
                Some(0) => {
                    return Err(format!(
                        "room membership secret {index} blob must not be empty"
                    ));
                }
                Some(len) if len > MAX_SECRET_BLOB_BYTES => {
                    return Err(format!(
                        "room membership secret {index} blob is {len} bytes; maximum is {MAX_SECRET_BLOB_BYTES}"
                    ));
                }
                Some(_) => {}
            }
        }
    }

    Ok(())
}

/// Validate the message invariants before signing. `time` is author-supplied
/// and unbounded; `author` is the caller's local key, checked in `lib.rs`.
pub fn message_error(epoch: u64, body: &str) -> Result<(), String> {
    if epoch == 0 {
        return Err("room message epoch must be greater than 0".into());
    }
    match decoded_lower_hex_len(body) {
        None => Err("room message body must be lowercase hex".into()),
        Some(0) => Err("room message body must not be empty".into()),
        Some(len) if len > MAX_BODY_BYTES => Err(format!(
            "room message body is {len} bytes; maximum is {MAX_BODY_BYTES}"
        )),
        Some(_) => Ok(()),
    }
}

/// Validate the candidate request invariants before signing. `time` is
/// author-supplied and unbounded; the owner and requester must be valid keys.
pub fn request_error(
    owner: &str,
    requester: &str,
    want_cell: &str,
    note: &str,
) -> Result<(), String> {
    validate_key("owner", owner)?;
    validate_key("requester", requester)?;
    want_cell_error(want_cell)?;
    note_error(note)
}

fn want_cell_error(want_cell: &str) -> Result<(), String> {
    if want_cell.len() > MAX_WANT_CELL_CHARS {
        return Err(format!(
            "candidate wantCell is {} characters; maximum is {MAX_WANT_CELL_CHARS}",
            want_cell.len()
        ));
    }
    if !want_cell.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return Err("candidate wantCell must contain only the digits 0-7".into());
    }
    Ok(())
}

fn note_error(note: &str) -> Result<(), String> {
    match decoded_lower_hex_len(note) {
        None => Err("candidate note must be lowercase hex".into()),
        Some(len) if len > MAX_NOTE_BYTES => Err(format!(
            "candidate note is {len} bytes; maximum is {MAX_NOTE_BYTES}"
        )),
        Some(_) => Ok(()),
    }
}

/// Validate a candidate request id: exactly 32 lowercase hex characters.
pub fn dismissal_error(id: &str) -> Result<(), String> {
    if !is_lower_hex(id, REQUEST_ID_HEX_LEN) {
        return Err(format!(
            "candidate request id must be exactly {REQUEST_ID_HEX_LEN} lowercase hex characters"
        ));
    }
    Ok(())
}

/// Validate the candidate config invariants before signing. The owner-only
/// rule is checked in `lib.rs`.
pub fn config_error(seq: u64) -> Result<(), String> {
    if seq == 0 {
        return Err("candidate config seq must be greater than 0".into());
    }
    Ok(())
}

/// Canonical candidate request signing bytes (`DESIGN-candidates.md` §3):
///
/// ```text
/// b"number:v1:candidate:request"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || requester: 32 bytes
/// || time: i64 LE
/// || want_cell_len: u16 LE
/// || want_cell: ASCII digits            // 0..=32 bytes
/// || note_len: u32 LE
/// || note                                // 0..=256 bytes
/// ```
pub fn request_signing_bytes(
    owner: &str,
    requester: &str,
    time: i64,
    want_cell: &str,
    note: &str,
) -> Result<Vec<u8>, String> {
    request_error(owner, requester, want_cell, note)?;

    let mut bytes = Vec::with_capacity(128);
    bytes.extend_from_slice(SIGNING_DOMAIN_REQUEST);
    bytes.extend_from_slice(CANDIDATE_TAG.as_bytes());
    bytes.extend_from_slice(&decode_exact::<32>("owner", owner)?);
    bytes.extend_from_slice(&decode_exact::<32>("requester", requester)?);
    bytes.extend_from_slice(&time.to_le_bytes());
    // Validation bounds the cell at 32 characters, so the cast is lossless.
    bytes.extend_from_slice(&(want_cell.len() as u16).to_le_bytes());
    bytes.extend_from_slice(want_cell.as_bytes());
    let note = decode_lower_hex(note).ok_or("candidate note must be lowercase hex")?;
    // Validation bounds the note at 256 bytes, so the cast is lossless.
    bytes.extend_from_slice(&(note.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&note);

    Ok(bytes)
}

/// Canonical candidate dismissal signing bytes (`DESIGN-candidates.md` §3):
///
/// ```text
/// b"number:v1:candidate:dismiss"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || request_id: 16 bytes               // BLAKE3(raw request sig)[0..16]
/// ```
pub fn dismissal_signing_bytes(owner: &str, id: &str) -> Result<Vec<u8>, String> {
    validate_key("owner", owner)?;
    dismissal_error(id)?;

    let mut bytes = Vec::with_capacity(64);
    bytes.extend_from_slice(SIGNING_DOMAIN_DISMISS);
    bytes.extend_from_slice(CANDIDATE_TAG.as_bytes());
    bytes.extend_from_slice(&decode_exact::<32>("owner", owner)?);
    bytes.extend_from_slice(&decode_exact::<16>("candidate request id", id)?);

    Ok(bytes)
}

/// Canonical candidate config signing bytes (`DESIGN-candidates.md` §3):
///
/// ```text
/// b"number:v1:candidate:config"
/// || tag: 4 bytes                       // b"ZCR1"
/// || owner_vk: 32 bytes
/// || seq: u64 LE
/// || accepting: u8                      // 0 or 1
/// ```
pub fn config_signing_bytes(owner: &str, seq: u64, accepting: bool) -> Result<Vec<u8>, String> {
    validate_key("owner", owner)?;
    config_error(seq)?;

    let mut bytes = Vec::with_capacity(64);
    bytes.extend_from_slice(SIGNING_DOMAIN_CONFIG);
    bytes.extend_from_slice(CANDIDATE_TAG.as_bytes());
    bytes.extend_from_slice(&decode_exact::<32>("owner", owner)?);
    bytes.extend_from_slice(&seq.to_le_bytes());
    bytes.push(u8::from(accepting));

    Ok(bytes)
}

/// Canonical membership signing bytes (`DESIGN-rooms.md` §3):
///
/// ```text
/// b"number:v1:room:membership"
/// || tag: 4 bytes                       // b"ZMR1" or b"ZCR1"
/// || owner_vk: 32 bytes
/// || seq: u64 LE
/// || member_count: u16 LE
/// || each member ascending: 32 bytes
/// || secret_count: u16 LE
/// || each secret ascending by recipient:
///      recipient: 32 bytes || blob_len: u32 LE || blob
/// ```
pub fn membership_signing_bytes(
    tag: &str,
    owner: &str,
    seq: u64,
    members: &[String],
    secrets: &[RoomSecret],
) -> Result<Vec<u8>, String> {
    validate_tag(tag)?;
    validate_key("owner", owner)?;
    membership_error(owner, seq, members, secrets)?;

    let mut bytes = Vec::with_capacity(128 + members.len() * 32);
    bytes.extend_from_slice(SIGNING_DOMAIN_MEMBERSHIP);
    bytes.extend_from_slice(tag.as_bytes());
    bytes.extend_from_slice(&decode_exact::<32>("owner", owner)?);
    bytes.extend_from_slice(&seq.to_le_bytes());
    // Validation bounds the member count at `MAX_MEMBERS`, so the cast is
    // lossless.
    bytes.extend_from_slice(&(members.len() as u16).to_le_bytes());
    for member in members {
        bytes.extend_from_slice(&decode_exact::<32>("room membership member", member)?);
    }
    // Validation keeps the secret list at either zero or `members.len()`.
    bytes.extend_from_slice(&(secrets.len() as u16).to_le_bytes());
    for secret in secrets {
        bytes.extend_from_slice(&decode_exact::<32>(
            "room membership secret recipient",
            &secret.recipient,
        )?);
        let blob = decode_lower_hex(&secret.blob)
            .ok_or("room membership secret blob must be lowercase hex")?;
        // Validation bounds the blob at 256 bytes, so the cast is lossless.
        bytes.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&blob);
    }

    Ok(bytes)
}

/// Canonical message signing bytes (`DESIGN-rooms.md` §3):
///
/// ```text
/// b"number:v1:room:message"
/// || tag: 4 bytes                       // b"ZMR1" or b"ZCR1"
/// || owner_vk: 32 bytes
/// || author: 32 bytes
/// || epoch: u64 LE
/// || seq: u64 LE
/// || time: i64 LE
/// || body_len: u32 LE
/// || body
/// ```
#[allow(clippy::too_many_arguments)]
pub fn message_signing_bytes(
    tag: &str,
    owner: &str,
    author: &str,
    epoch: u64,
    seq: u64,
    time: i64,
    body: &str,
) -> Result<Vec<u8>, String> {
    validate_tag(tag)?;
    validate_key("owner", owner)?;
    validate_key("author", author)?;
    message_error(epoch, body)?;

    let mut bytes = Vec::with_capacity(128);
    bytes.extend_from_slice(SIGNING_DOMAIN_MESSAGE);
    bytes.extend_from_slice(tag.as_bytes());
    bytes.extend_from_slice(&decode_exact::<32>("owner", owner)?);
    bytes.extend_from_slice(&decode_exact::<32>("author", author)?);
    bytes.extend_from_slice(&epoch.to_le_bytes());
    bytes.extend_from_slice(&seq.to_le_bytes());
    bytes.extend_from_slice(&time.to_le_bytes());
    let body = decode_lower_hex(body).ok_or("room message body must be lowercase hex")?;
    // Validation bounds the body at 1024 bytes, so the cast is lossless.
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);

    Ok(bytes)
}

/// Derive the message id: `BLAKE3(raw_sig)[0..16]` as 32 lowercase hex chars.
pub fn message_id(sig: &str) -> Result<String, String> {
    let raw = decode_exact::<64>("room message sig", sig)?;
    let digest = blake3::hash(&raw);
    Ok(hex::encode(&digest.as_bytes()[..16]))
}

/// Derive the candidate request id: `BLAKE3(raw_sig)[0..16]` as 32 lowercase
/// hex chars. Mirrors [`message_id`].
pub fn request_id(sig: &str) -> Result<String, String> {
    let raw = decode_exact::<64>("candidate request sig", sig)?;
    let digest = blake3::hash(&raw);
    Ok(hex::encode(&digest.as_bytes()[..16]))
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_exact<const N: usize>(field: &str, value: &str) -> Result<[u8; N], String> {
    let decoded =
        hex::decode(value).map_err(|error| format!("{field} is not valid hex: {error}"))?;
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| format!("{field} must be {N} bytes, got {}", decoded.len()))
}

/// Decode lowercase hex, returning `None` for uppercase, non-hex or odd length.
fn decode_lower_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    hex::decode(value).ok()
}

fn decoded_lower_hex_len(value: &str) -> Option<usize> {
    decode_lower_hex(value).map(|bytes| bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
    const AUTHOR: &str = "66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a";
    const ROOM_ID: &str = "6RQvoNj3CQV2AWTruyuExE3gMcXyxWK2cmE47rPXowrV";

    fn secret(recipient: &str, blob: &str) -> RoomSecret {
        RoomSecret {
            recipient: recipient.into(),
            blob: blob.into(),
        }
    }

    #[test]
    fn golden_membership_bytes_match_fixture_shape() {
        let members = vec![AUTHOR.into(), OWNER.into()];
        let secrets = vec![secret(AUTHOR, "deadbeef"), secret(OWNER, "0102030405")];
        let bytes = membership_signing_bytes(ROOM_TAG, OWNER, 3, &members, &secrets)
            .expect("golden membership is valid");
        let hex = hex::encode(&bytes);
        assert!(hex.starts_with("6e756d6265723a76313a726f6f6d3a6d656d626572736869705a4d5231"));
        assert!(hex.ends_with("020066be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a04000000deadbeefea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c050000000102030405"));
    }

    #[test]
    fn tags_and_room_ids_are_strict() {
        assert!(validate_tag("ZMR1").is_ok());
        assert!(validate_tag("ZCR1").is_ok());
        assert!(validate_tag("zmr1").is_err());
        assert!(validate_tag("ZCX1").is_err());
        assert!(validate_tag("").is_err());
        assert_eq!(tag_bytes("ZMR1").unwrap(), *b"ZMR1");
        assert_eq!(tag_bytes("ZCR1").unwrap(), *b"ZCR1");
        assert!(tag_bytes("ZCX1").is_err());
        assert!(decode_room_id(ROOM_ID).is_ok());
        assert!(decode_room_id("not base58!").is_err());
        assert!(decode_room_id("1111").is_err());
    }

    #[test]
    fn membership_rejects_bad_shapes() {
        let members = vec![AUTHOR.into(), OWNER.into()];
        assert!(membership_error(OWNER, 0, &members, &[]).is_err());
        assert!(membership_error(OWNER, 1, &[OWNER.into(), AUTHOR.into()], &[]).is_err());
        assert!(membership_error(OWNER, 1, &[AUTHOR.into(), AUTHOR.into()], &[]).is_err());
        assert!(membership_error(OWNER, 1, &[AUTHOR.into()], &[]).is_err());
        assert!(membership_error("aa".repeat(32).as_str(), 1, &members, &[]).is_err());
        assert!(membership_error(OWNER, 1, &members, &[secret(AUTHOR, "deadbeef")]).is_err());
        assert!(
            membership_error(
                OWNER,
                1,
                &members,
                &[secret(OWNER, "deadbeef"), secret(AUTHOR, "01")]
            )
            .is_err()
        );
        assert!(
            membership_error(
                OWNER,
                1,
                &members,
                &[secret(AUTHOR, ""), secret(OWNER, "01")]
            )
            .is_err()
        );
        assert!(
            membership_error(
                OWNER,
                1,
                &members,
                &[
                    secret(AUTHOR, &"00".repeat(MAX_SECRET_BLOB_BYTES + 1)),
                    secret(OWNER, "01")
                ]
            )
            .is_err()
        );
    }

    #[test]
    fn message_rejects_bad_shapes() {
        assert!(message_error(0, "00").is_err());
        assert!(message_error(1, "").is_err());
        assert!(message_error(1, "0").is_err());
        assert!(message_error(1, "zz").is_err());
        assert!(message_error(1, &"00".repeat(MAX_BODY_BYTES + 1)).is_err());
        assert!(message_error(1, &"00".repeat(MAX_BODY_BYTES)).is_ok());
    }

    #[test]
    fn message_id_is_blake3_prefix() {
        let sig = "39dd6fe88a5f8c42a7c4e30df63d33741fae1a6a67498745faab4a9d5c847a9f89c8ba33971b62a1c502c42c158f8538c0e55476468f10024ee2a3c68d8ece0f";
        assert_eq!(message_id(sig).unwrap(), "0a6f7b7b9779685eb872a43d57bbfb69");
    }

    // Candidate-room golden vectors from `fixtures/candidate/golden_v1.json`.
    const GOLDEN_REQUESTER: &str =
        "884b8857f4eaa1613c61504db34d4beaf346517a0e31de3cddd4d9b4201d9d0b";
    const GOLDEN_REQUEST_SIG: &str = "011e2039634d765cfafba0673cfe9045bd625c1db09ff2eba7088a085acfe78004eddad0ae571ed75d408593cc22789ec35a50037f671fa3372841d29b31e806";
    const GOLDEN_REQUEST_ID: &str = "bab77af391cff0cfe0f4674852b8d40e";

    #[test]
    fn golden_candidate_request_bytes_match_fixture() {
        let requester = hex::encode(
            ed25519_dalek::SigningKey::from_bytes(&[0x21u8; 32])
                .verifying_key()
                .to_bytes(),
        );
        assert_eq!(requester, GOLDEN_REQUESTER);

        let bytes = request_signing_bytes(
            OWNER,
            &requester,
            1762500000001,
            "003",
            "6c6574206d6520696e",
        )
        .expect("golden request is valid");
        assert_eq!(
            hex::encode(&bytes),
            "6e756d6265723a76313a63616e6469646174653a726571756573745a435231ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c884b8857f4eaa1613c61504db34d4beaf346517a0e31de3cddd4d9b4201d9d0b01b92f5d9a0100000300303033090000006c6574206d6520696e"
        );
        assert_eq!(request_id(GOLDEN_REQUEST_SIG).unwrap(), GOLDEN_REQUEST_ID);
    }

    #[test]
    fn request_signing_bytes_bind_every_field() {
        let requester = GOLDEN_REQUESTER;
        let base =
            request_signing_bytes(OWNER, requester, 1762500000001, "003", "6c6574206d6520696e")
                .unwrap();

        let variants = [
            request_signing_bytes(
                AUTHOR,
                requester,
                1762500000001,
                "003",
                "6c6574206d6520696e",
            )
            .unwrap(),
            request_signing_bytes(OWNER, AUTHOR, 1762500000001, "003", "6c6574206d6520696e")
                .unwrap(),
            request_signing_bytes(OWNER, requester, 1762500000002, "003", "6c6574206d6520696e")
                .unwrap(),
            request_signing_bytes(OWNER, requester, 1762500000001, "004", "6c6574206d6520696e")
                .unwrap(),
            request_signing_bytes(
                OWNER,
                requester,
                1762500000001,
                "003",
                "6c6574206d6520696e20",
            )
            .unwrap(),
        ];
        for variant in variants {
            assert_ne!(base, variant);
        }
    }

    #[test]
    fn candidate_records_reject_bad_shapes() {
        let requester = GOLDEN_REQUESTER;

        // Empty cell (the world) and empty note are allowed.
        assert!(request_error(OWNER, requester, "", "").is_ok());
        let bad_key = format!("02{}", "00".repeat(31));
        assert!(request_error(&bad_key, requester, "", "").is_err());
        assert!(request_error(OWNER, &bad_key, "", "").is_err());
        assert!(request_error(OWNER, requester, "8", "").is_err());
        assert!(request_error(OWNER, requester, "0a", "").is_err());
        assert!(request_error(OWNER, requester, &"0".repeat(MAX_WANT_CELL_CHARS + 1), "").is_err());
        assert!(request_error(OWNER, requester, "", "0").is_err());
        assert!(request_error(OWNER, requester, "", "AA").is_err());
        assert!(request_error(OWNER, requester, "", "zz").is_err());
        assert!(request_error(OWNER, requester, "", &"00".repeat(MAX_NOTE_BYTES + 1)).is_err());
        assert!(request_error(OWNER, requester, "", &"00".repeat(MAX_NOTE_BYTES)).is_ok());

        // Dismissal ids are exactly 32 lowercase hex characters.
        for bad_id in [
            "",
            "zz",
            "BAB77AF391CFF0CFE0F4674852B8D40E",
            "bab77af391cff0cfe0f4674852b8d40",
        ] {
            assert!(dismissal_error(bad_id).is_err());
            assert!(dismissal_signing_bytes(OWNER, bad_id).is_err());
        }
        assert!(dismissal_error(GOLDEN_REQUEST_ID).is_ok());
        assert_eq!(
            hex::encode(dismissal_signing_bytes(OWNER, GOLDEN_REQUEST_ID).unwrap()),
            "6e756d6265723a76313a63616e6469646174653a6469736d6973735a435231ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22cbab77af391cff0cfe0f4674852b8d40e"
        );

        // Config seq is positive and accepting is exactly one byte.
        assert!(config_error(0).is_err());
        assert!(config_error(1).is_ok());
        assert_eq!(
            hex::encode(config_signing_bytes(OWNER, 1, true).unwrap()),
            "6e756d6265723a76313a63616e6469646174653a636f6e6669675a435231ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c010000000000000001"
        );
        assert_eq!(
            config_signing_bytes(OWNER, 1, false).unwrap().last(),
            Some(&0)
        );
        assert_ne!(
            config_signing_bytes(OWNER, 1, true).unwrap(),
            config_signing_bytes(OWNER, 2, true).unwrap()
        );
        assert_ne!(
            config_signing_bytes(OWNER, 1, true).unwrap(),
            config_signing_bytes(OWNER, 1, false).unwrap()
        );
    }
}
