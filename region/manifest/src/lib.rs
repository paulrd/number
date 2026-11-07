//! `region-manifest` — a publisher-owned signed last-writer-wins register.
//!
//! State is `seq || payload_len || payload || signature`. The payload is opaque
//! to the contract (the dataset format is the tool's and the client's); the
//! signature binds the sequence number, the parameters and the payload to the
//! publisher key in the parameters.
//!
//! Merge is the maximum over `(seq, BLAKE3(full_state_bytes))`. The full-state
//! hash, not the payload hash, breaks ties: two valid signatures over the same
//! payload must never leave peers holding different bytes while their
//! summaries agree.

use ed25519_dalek::{Signature, VerifyingKey};
use freenet_stdlib::prelude::*;
use region_wire as wire;

pub const MAGIC: [u8; 4] = *b"MGB1";
pub const PARAMS_LEN: usize = 52;

pub struct RegionManifest;

fn publisher_key(parameters: &Parameters<'_>) -> Result<VerifyingKey, ContractError> {
    let bytes = parameters.as_ref();
    if bytes.len() != PARAMS_LEN || &bytes[..4] != MAGIC.as_slice() {
        return Err(ContractError::Other(
            "region-manifest parameters must be MGB1 || publisher key || namespace".into(),
        ));
    }
    let key: [u8; 32] = bytes[4..36].try_into().expect("checked parameter length");
    VerifyingKey::from_bytes(&key)
        .map_err(|_| ContractError::Other("parameters carry an invalid publisher key".into()))
}

/// Validate one complete state and return its merge key.
///
/// A bare `Delta` has the same shape as a `State`: `get_state_delta` returns
/// the full state, so the caller passes those bytes here either way.
fn candidate_key(
    params: &[u8],
    key: &VerifyingKey,
    bytes: &[u8],
) -> Result<(u64, [u8; 32]), ContractError> {
    let envelope = wire::decode_state(bytes).map_err(|_| ContractError::InvalidUpdate)?;
    let signature = Signature::from_bytes(&envelope.signature);
    key.verify_strict(
        &wire::signing_bytes(params, envelope.seq, envelope.payload),
        &signature,
    )
    .map_err(|_| ContractError::InvalidUpdate)?;
    Ok((envelope.seq, wire::state_hash(bytes)))
}

#[contract]
impl ContractInterface for RegionManifest {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let Ok(key) = publisher_key(&parameters) else {
            return Ok(ValidateResult::Invalid);
        };
        Ok(
            match candidate_key(parameters.as_ref(), &key, state.as_ref()) {
                Ok(_) => ValidateResult::Valid,
                Err(_) => ValidateResult::Invalid,
            },
        )
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let key = publisher_key(&parameters)?;
        let params = parameters.as_ref();

        // A single invalid candidate rejects the update: the only legitimate
        // signer is the publisher, so an invalid envelope is not a merge input.
        let current = candidate_key(params, &key, state.as_ref())?;
        let mut best: (u64, [u8; 32], Vec<u8>) = (current.0, current.1, state.as_ref().to_vec());

        for item in &data {
            let bytes: &[u8] = match item {
                UpdateData::State(incoming) => incoming.as_ref(),
                UpdateData::Delta(delta) => delta.as_ref(),
                UpdateData::StateAndDelta {
                    state: incoming, ..
                } => incoming.as_ref(),
                _ => return Err(ContractError::InvalidUpdate),
            };
            let candidate = candidate_key(params, &key, bytes)?;
            if candidate > (best.0, best.1) {
                best = (candidate.0, candidate.1, bytes.to_vec());
            }
        }

        Ok(UpdateModification::valid(State::from(best.2)))
    }

    fn summarize_state(
        parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let key = publisher_key(&parameters)?;
        let (seq, _) = candidate_key(parameters.as_ref(), &key, state.as_ref())?;
        Ok(StateSummary::from(
            wire::summary(seq, state.as_ref()).to_vec(),
        ))
    }

    fn get_state_delta(
        parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let key = publisher_key(&parameters)?;
        let params = parameters.as_ref();
        let local = candidate_key(params, &key, state.as_ref())?;

        match wire::decode_summary(summary.as_ref()) {
            // A new subscriber presents an empty summary: send everything.
            None => Ok(StateDelta::from(state.as_ref().to_vec())),
            // Never send a downgrade to an equal-or-newer peer.
            Some(remote) if remote >= local => Ok(StateDelta::from(Vec::new())),
            Some(_) => Ok(StateDelta::from(state.as_ref().to_vec())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn params(key: &SigningKey) -> Parameters<'static> {
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&key.verifying_key().to_bytes());
        bytes.extend_from_slice(&[1u8; 16]);
        Parameters::from(bytes)
    }

    fn signed(key: &SigningKey, seq: u64, payload: &[u8]) -> Vec<u8> {
        let parameters = params(key);
        let signature = key.sign(&wire::signing_bytes(parameters.as_ref(), seq, payload));
        wire::encode_state(seq, payload, &signature.to_bytes()).expect("test envelope")
    }

    fn state_of(key: &SigningKey, payload: &[u8]) -> State<'static> {
        State::from(signed(key, 1, payload))
    }

    #[test]
    fn validates_a_publisher_signature() {
        let key = test_key();
        let state = state_of(&key, b"payload");
        assert_eq!(
            RegionManifest::validate_state(
                params(&key),
                state.clone(),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Valid
        );
        assert_eq!(
            RegionManifest::validate_state(
                params(&SigningKey::from_bytes(&[8u8; 32])),
                state,
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn rejects_tampering_and_bad_parameters() {
        let key = test_key();
        let good = signed(&key, 1, b"payload");

        let mut wrong_payload = good.clone();
        wrong_payload[12] ^= 1;
        assert_eq!(
            RegionManifest::validate_state(
                params(&key),
                State::from(wrong_payload),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );

        let mut wrong_seq = good.clone();
        wrong_seq[0] = 9;
        assert_eq!(
            RegionManifest::validate_state(
                params(&key),
                State::from(wrong_seq),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );

        let mut wrong_sig = good.clone();
        let last = wrong_sig.len() - 1;
        wrong_sig[last] ^= 1;
        assert_eq!(
            RegionManifest::validate_state(
                params(&key),
                State::from(wrong_sig),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );

        for parameters in [
            Parameters::from(Vec::new()),
            Parameters::from(b"MGB1".to_vec()),
            Parameters::from(b"RGB1".to_vec()),
        ] {
            assert_eq!(
                RegionManifest::validate_state(
                    parameters,
                    State::from(good.clone()),
                    RelatedContracts::default(),
                )
                .unwrap(),
                ValidateResult::Invalid
            );
        }
    }

    #[test]
    fn higher_seq_wins_and_lower_seq_never_replaces() {
        let key = test_key();
        let parameters = params(&key);
        let older = State::from(signed(&key, 1, b"one"));
        let newer = State::from(signed(&key, 2, b"two"));

        let updated = RegionManifest::update_state(
            parameters.clone(),
            older,
            vec![UpdateData::State(newer.clone())],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(updated.as_ref(), newer.as_ref());

        let stale = State::from(signed(&key, 1, b"stale"));
        let updated = RegionManifest::update_state(
            parameters,
            newer.clone(),
            vec![UpdateData::Delta(StateDelta::from(stale.as_ref().to_vec()))],
        )
        .unwrap()
        .unwrap_valid();
        assert_eq!(updated.as_ref(), newer.as_ref());
    }

    #[test]
    fn equal_seq_is_broken_deterministically_by_the_full_state_hash() {
        let key = test_key();
        let parameters = params(&key);
        let first = signed(&key, 5, b"alpha");
        let second = signed(&key, 5, b"beta");
        let first_key = wire::state_hash(&first);
        let second_key = wire::state_hash(&second);
        let (low, high, low_key, high_key) = if first_key > second_key {
            (&second, &first, second_key, first_key)
        } else {
            (&first, &second, first_key, second_key)
        };
        assert_ne!(low_key, high_key);

        for (current, incoming) in [
            (low.as_slice(), high.as_slice()),
            (high.as_slice(), low.as_slice()),
        ] {
            let updated = RegionManifest::update_state(
                parameters.clone(),
                State::from(current.to_vec()),
                vec![UpdateData::State(State::from(incoming.to_vec()))],
            )
            .unwrap()
            .unwrap_valid();
            assert_eq!(updated.as_ref(), high.as_slice());
        }
    }

    #[test]
    fn reordered_candidates_converge() {
        let key = test_key();
        let parameters = params(&key);
        let one = signed(&key, 1, b"one");
        let two = signed(&key, 2, b"two");
        let three = signed(&key, 3, b"three");

        let forward = RegionManifest::update_state(
            parameters.clone(),
            State::from(one.clone()),
            vec![
                UpdateData::State(State::from(two.clone())),
                UpdateData::State(State::from(three.clone())),
            ],
        )
        .unwrap()
        .unwrap_valid();

        let backward = RegionManifest::update_state(
            parameters,
            State::from(one),
            vec![
                UpdateData::State(State::from(three.clone())),
                UpdateData::State(State::from(two)),
            ],
        )
        .unwrap()
        .unwrap_valid();

        assert_eq!(forward.as_ref(), backward.as_ref());
        assert_eq!(forward.as_ref(), three.as_slice());
    }

    #[test]
    fn rejects_an_invalid_candidate_atomically() {
        let key = test_key();
        let parameters = params(&key);
        let current = State::from(signed(&key, 1, b"one"));
        let good = signed(&key, 2, b"two");
        let mut bad = signed(&key, 3, b"three");
        let last = bad.len() - 1;
        bad[last] ^= 1;

        let error = RegionManifest::update_state(
            parameters,
            current,
            vec![
                UpdateData::State(State::from(good)),
                UpdateData::State(State::from(bad)),
            ],
        );
        assert!(error.is_err());
    }

    #[test]
    fn summary_and_delta_follow_the_peer() {
        let key = test_key();
        let parameters = params(&key);
        let state = state_of(&key, b"payload");
        let seq_hash = (1u64, wire::state_hash(state.as_ref()));

        let summary = RegionManifest::summarize_state(parameters.clone(), state.clone()).unwrap();
        assert_eq!(wire::decode_summary(summary.as_ref()), Some(seq_hash));

        // Empty summary (new subscriber) -> full state.
        let full = RegionManifest::get_state_delta(
            parameters.clone(),
            state.clone(),
            StateSummary::from(Vec::new()),
        )
        .unwrap();
        assert_eq!(full.as_ref(), state.as_ref());

        // Equal summary -> nothing.
        let empty = RegionManifest::get_state_delta(
            parameters.clone(),
            state.clone(),
            StateSummary::from(summary.as_ref().to_vec()),
        )
        .unwrap();
        assert!(empty.as_ref().is_empty());

        // Newer peer -> nothing.
        let newer = StateSummary::from(wire::summary(2, b"newer").to_vec());
        let empty =
            RegionManifest::get_state_delta(parameters.clone(), state.clone(), newer).unwrap();
        assert!(empty.as_ref().is_empty());

        // Older peer -> full state.
        let older = StateSummary::from(wire::summary(0, b"older").to_vec());
        let full = RegionManifest::get_state_delta(parameters, state.clone(), older).unwrap();
        assert_eq!(full.as_ref(), state.as_ref());
    }
}
