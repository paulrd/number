//! Byte codecs shared by the region manifest contract and the publisher tool.
//!
//! This crate deliberately knows nothing about the region payload: the
//! contract treats the payload as opaque and the tool/UI own its format. It
//! covers the signed envelope and the summary key only, because those two must
//! agree exactly between the contract and the tool or signatures and deltas
//! break.

/// Manifest contract parameters: magic || publisher verifying key (32) ||
/// namespace (16).
pub const MANIFEST_MAGIC: [u8; 4] = *b"MGB1";
pub const MANIFEST_PARAMS_LEN: usize = 52;
/// Domain separator for the manifest signature.
pub const MANIFEST_DOMAIN: &[u8] = b"number:region-manifest:v1";
/// Hard cap on the manifest payload (DESIGN-regions.md §5.2).
pub const MAX_PAYLOAD: usize = 4 * 1024 * 1024;
pub const SIGNATURE_LEN: usize = 64;
pub const HEADER_LEN: usize = 8 + 4;
pub const SUMMARY_LEN: usize = 8 + 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    TooShort,
    TooLong,
    BadLength,
    ZeroSeq,
}

/// A decoded manifest state. The payload and signature borrow the input bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Envelope<'a> {
    pub seq: u64,
    pub payload: &'a [u8],
    pub signature: [u8; SIGNATURE_LEN],
}

/// `"number:region-manifest:v1" || params || seq_LE || payload`
pub fn signing_bytes(params: &[u8], seq: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MANIFEST_DOMAIN.len() + params.len() + 8 + payload.len());
    out.extend_from_slice(MANIFEST_DOMAIN);
    out.extend_from_slice(params);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Decode `seq || payload_len || payload || signature`.
pub fn decode_state(bytes: &[u8]) -> Result<Envelope<'_>, WireError> {
    if bytes.len() < HEADER_LEN + SIGNATURE_LEN {
        return Err(WireError::TooShort);
    }
    let seq = u64::from_le_bytes(bytes[..8].try_into().expect("checked length"));
    if seq == 0 {
        return Err(WireError::ZeroSeq);
    }
    let payload_len = u32::from_le_bytes(bytes[8..12].try_into().expect("checked length")) as usize;
    if payload_len > MAX_PAYLOAD {
        return Err(WireError::TooLong);
    }
    let expected = HEADER_LEN
        .checked_add(payload_len)
        .and_then(|value| value.checked_add(SIGNATURE_LEN))
        .ok_or(WireError::TooLong)?;
    if bytes.len() != expected {
        return Err(WireError::BadLength);
    }
    let payload = &bytes[HEADER_LEN..HEADER_LEN + payload_len];
    let mut signature = [0u8; SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[HEADER_LEN + payload_len..]);
    Ok(Envelope {
        seq,
        payload,
        signature,
    })
}

/// Encode a state; rejects a zero sequence and an oversized payload.
pub fn encode_state(
    seq: u64,
    payload: &[u8],
    signature: &[u8; SIGNATURE_LEN],
) -> Result<Vec<u8>, WireError> {
    if seq == 0 {
        return Err(WireError::ZeroSeq);
    }
    if payload.len() > MAX_PAYLOAD {
        return Err(WireError::TooLong);
    }
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len() + SIGNATURE_LEN);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(signature);
    Ok(out)
}

/// `BLAKE3(full_state_bytes)`, the second half of the manifest summary and the
/// tie-break in the merge order.
pub fn state_hash(full_state: &[u8]) -> [u8; 32] {
    *blake3::hash(full_state).as_bytes()
}

/// `seq_LE || BLAKE3(full_state_bytes)`.
pub fn summary(seq: u64, full_state: &[u8]) -> [u8; SUMMARY_LEN] {
    let mut out = [0u8; SUMMARY_LEN];
    out[..8].copy_from_slice(&seq.to_le_bytes());
    out[8..].copy_from_slice(&state_hash(full_state));
    out
}

/// Decode a summary key; `None` for an empty or malformed summary (a new
/// subscriber presents an empty one).
pub fn decode_summary(bytes: &[u8]) -> Option<(u64, [u8; 32])> {
    if bytes.len() != SUMMARY_LEN {
        return None;
    }
    let seq = u64::from_le_bytes(bytes[..8].try_into().ok()?);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&bytes[8..]);
    Some((seq, hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Vec<u8> {
        let mut params = MANIFEST_MAGIC.to_vec();
        params.extend_from_slice(&[3u8; 32]);
        params.extend_from_slice(&[5u8; 16]);
        params
    }

    #[test]
    fn round_trips_an_envelope() {
        let payload = b"manifest payload";
        let sig = [9u8; SIGNATURE_LEN];
        let bytes = encode_state(7, payload, &sig).expect("encodes");
        let envelope = decode_state(&bytes).expect("decodes");
        assert_eq!(envelope.seq, 7);
        assert_eq!(envelope.payload, payload);
        assert_eq!(envelope.signature, sig);
    }

    #[test]
    fn rejects_zero_seq_and_bad_lengths() {
        assert_eq!(encode_state(0, b"x", &[0u8; 64]), Err(WireError::ZeroSeq));
        assert_eq!(decode_state(&[0u8; 11]), Err(WireError::TooShort));

        let mut bytes = encode_state(1, b"xy", &[0u8; 64]).expect("encodes");
        bytes.truncate(bytes.len() - 1);
        assert_eq!(decode_state(&bytes), Err(WireError::BadLength));

        let mut bytes = encode_state(1, b"xy", &[0u8; 64]).expect("encodes");
        bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_state(&bytes), Err(WireError::TooLong));
    }

    #[test]
    fn signing_bytes_are_domain_separated_and_ordered() {
        let p = params();
        let a = signing_bytes(&p, 1, b"one");
        let b = signing_bytes(&p, 2, b"one");
        let c = signing_bytes(&p, 1, b"two");
        let other = signing_bytes(&[9u8; 52], 1, b"one");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, other);
        assert!(a.starts_with(MANIFEST_DOMAIN));
    }

    #[test]
    fn summary_round_trip_and_tie_break_material() {
        let one = summary(3, b"same payload");
        let two = summary(3, b"same payload");
        assert_eq!(one, two);
        assert_eq!(decode_summary(&one), Some((3, state_hash(b"same payload"))));
        assert_eq!(decode_summary(&[]), None);
        assert_eq!(decode_summary(&one[..39]), None);
        assert_ne!(summary(3, b"a"), summary(4, b"a"));
        assert_ne!(state_hash(b"a"), state_hash(b"b"));
    }
}
