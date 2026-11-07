//! `region-blob` — a generic immutable content-addressed blob.
//!
//! The contract id is bound to the bytes: the parameters carry the BLAKE3 hash
//! of the state, and `validate_state` recomputes it. There is exactly one
//! admissible state per instance, so the merge is a no-op and the only legal
//! update is the state that is already there.
//!
//! State is opaque; the dataset format lives in `DESIGN-regions.md` §6 and is
//! parsed by the client, never here. That keeps this contract stable across
//! row-format changes.

use freenet_stdlib::prelude::*;

/// Contract parameters: magic || BLAKE3(state).
pub const MAGIC: [u8; 4] = *b"RGB1";
pub const PARAMS_LEN: usize = 36;
/// Hard cap on a shard state (DESIGN-regions.md §5.1).
pub const MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;

pub struct RegionBlob;

/// The content hash carried in the parameters, or an error if the parameters
/// do not have the expected shape.
fn content_hash(parameters: &Parameters<'_>) -> Result<[u8; 32], ContractError> {
    let bytes = parameters.as_ref();
    if bytes.len() != PARAMS_LEN || &bytes[..4] != MAGIC.as_slice() {
        return Err(ContractError::Other(
            "region-blob parameters must be RGB1 || BLAKE3(state)".into(),
        ));
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&bytes[4..]);
    Ok(hash)
}

fn validate_blob(hash: &[u8; 32], bytes: &[u8]) -> Result<(), ContractError> {
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(ContractError::InvalidUpdate);
    }
    if blake3::hash(bytes).as_bytes() != hash {
        return Err(ContractError::InvalidUpdate);
    }
    Ok(())
}

#[contract]
impl ContractInterface for RegionBlob {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let Ok(hash) = content_hash(&parameters) else {
            return Ok(ValidateResult::Invalid);
        };
        Ok(match validate_blob(&hash, state.as_ref()) {
            Ok(()) => ValidateResult::Valid,
            Err(_) => ValidateResult::Invalid,
        })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let hash = content_hash(&parameters)?;
        validate_blob(&hash, state.as_ref())?;
        if data.is_empty() {
            return Ok(UpdateModification::valid(state));
        }

        // A `Delta` returned by `get_state_delta` is the full state, so every
        // variant carries the same complete bytes. The only admissible bytes
        // are the current ones; anything else is rejected atomically.
        for item in &data {
            let bytes: &[u8] = match item {
                UpdateData::State(incoming) => incoming.as_ref(),
                UpdateData::Delta(delta) => delta.as_ref(),
                UpdateData::StateAndDelta {
                    state: incoming, ..
                } => incoming.as_ref(),
                _ => return Err(ContractError::InvalidUpdate),
            };
            validate_blob(&hash, bytes)?;
            if bytes != state.as_ref() {
                return Err(ContractError::InvalidUpdate);
            }
        }

        Ok(UpdateModification::valid(State::from(
            state.as_ref().to_vec(),
        )))
    }

    fn summarize_state(
        parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let hash = content_hash(&parameters)?;
        validate_blob(&hash, state.as_ref())?;
        Ok(StateSummary::from(hash.to_vec()))
    }

    fn get_state_delta(
        parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let hash = content_hash(&parameters)?;
        validate_blob(&hash, state.as_ref())?;
        if summary.as_ref() == hash.as_slice() {
            Ok(StateDelta::from(Vec::new()))
        } else {
            Ok(StateDelta::from(state.as_ref().to_vec()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(state: &[u8]) -> Parameters<'static> {
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(blake3::hash(state).as_bytes());
        Parameters::from(bytes)
    }

    fn blob() -> Vec<u8> {
        let mut bytes = b"RGN1\x02".to_vec();
        bytes.extend_from_slice(&[0u8; 32]);
        bytes
    }

    #[test]
    fn validates_only_the_state_the_parameters_name() {
        let state = blob();
        assert_eq!(
            RegionBlob::validate_state(
                params(&state),
                State::from(state.clone()),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Valid
        );

        let mut tampered = state.clone();
        tampered[0] ^= 1;
        assert_eq!(
            RegionBlob::validate_state(
                params(&state),
                State::from(tampered),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn rejects_bad_parameters() {
        let state = blob();
        for parameters in [
            Parameters::from(Vec::new()),
            Parameters::from(b"RGB1".to_vec()),
            Parameters::from(b"RGB2".to_vec()),
        ] {
            assert_eq!(
                RegionBlob::validate_state(
                    parameters,
                    State::from(state.clone()),
                    RelatedContracts::default(),
                )
                .unwrap(),
                ValidateResult::Invalid
            );
        }
    }

    #[test]
    fn oversized_state_is_invalid() {
        let state = vec![0u8; MAX_BLOB_BYTES + 1];
        // Build params for the oversized state so the length check is what
        // rejects it, not the hash.
        assert_eq!(
            RegionBlob::validate_state(
                params(&state),
                State::from(state),
                RelatedContracts::default(),
            )
            .unwrap(),
            ValidateResult::Invalid
        );
    }

    #[test]
    fn identical_state_is_a_no_op_in_every_update_shape() {
        let state = blob();
        let parameters = params(&state);
        let current = State::from(state.clone());

        for data in [
            vec![UpdateData::State(State::from(state.clone()))],
            vec![UpdateData::Delta(StateDelta::from(state.clone()))],
            vec![UpdateData::StateAndDelta {
                state: State::from(state.clone()),
                delta: StateDelta::from(state.clone()),
            }],
            Vec::new(),
        ] {
            let updated = RegionBlob::update_state(parameters.clone(), current.clone(), data)
                .unwrap()
                .unwrap_valid();
            assert_eq!(updated.as_ref(), state.as_slice());
        }
    }

    #[test]
    fn a_different_state_is_rejected() {
        let state = blob();
        let mut other = state.clone();
        other.push(0);
        let error = RegionBlob::update_state(
            params(&state),
            State::from(state.clone()),
            vec![UpdateData::Delta(StateDelta::from(other))],
        );
        assert!(error.is_err());
    }

    #[test]
    fn summary_and_delta_converge() {
        let state = blob();
        let parameters = params(&state);
        let hash = blake3::hash(&state);

        let summary =
            RegionBlob::summarize_state(parameters.clone(), State::from(state.clone())).unwrap();
        assert_eq!(summary.as_ref(), hash.as_bytes());

        let empty = RegionBlob::get_state_delta(
            parameters.clone(),
            State::from(state.clone()),
            StateSummary::from(hash.as_bytes().to_vec()),
        )
        .unwrap();
        assert!(empty.as_ref().is_empty());

        let full = RegionBlob::get_state_delta(
            parameters,
            State::from(state.clone()),
            StateSummary::from(Vec::new()),
        )
        .unwrap();
        assert_eq!(full.as_ref(), state.as_slice());
    }
}
