//! Generate a deterministic replay corpus for `fdev verify-merge`.
//!
//! Usage:
//!
//! ```text
//! cargo run --locked --example gen_corpus -- <output-directory> <contract-wasm>
//! ```
//!
//! Writes `corpus.bundle` (a `ReplayBundle`, schema 1) and `params.bin` (the raw
//! 32-byte Ed25519 verifying key). The bundle is what makes the check meaningful:
//! `--state`/`--transition` alone supply no deltas and no summaries, so
//! `delta_idempotence` and `delta_permutation_invariance` generate zero cases and
//! `delta_determinism` can only test the self-summary (see BACKLOG #7).
//!
//! Everything here is derived from the contract's own `get_state_delta` and
//! `update_state`, so the deltas are exactly what the network would compute, and
//! every transition is re-applied before it is written. The signing key is a fixed
//! seed, so the corpus is reproducible.
//!
//! The bundle struct below mirrors `freenet::conformance::bundle::ReplayBundle`
//! field for field. Bincode encodes struct fields in declaration order with no
//! names, so keeping the shapes identical is what makes the file readable by
//! `fdev` without depending on the node crate. Schema 1 is pinned by the magic
//! and version; a core-side change is a loud decode failure, not a silent
//! misinterpretation.

use std::error::Error;
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use freenet_stdlib::prelude::{
    ContractInterface, Parameters, State, StateDelta, StateSummary, UpdateData,
};
use number_contract::{
    Entry, MAX_NOTE_BYTES, NumberContract, Slot, StateV1, Summary, signing_bytes,
};
use serde::Serialize;

/// Fixed Ed25519 seed; must never be used outside this example/corpus.
const CORPUS_SEED: [u8; 32] = [0x42; 32];

const BUNDLE_MAGIC: &[u8; 8] = b"FRNTCNF1";
const BUNDLE_SCHEMA_VERSION: u16 = 1;

/// Mirror of `freenet::conformance::bundle::ReplayBundle`, schema 1.
#[derive(Serialize)]
struct ReplayBundle {
    schema_version: u16,
    code: Option<Vec<u8>>,
    code_hash: Option<[u8; 32]>,
    parameters: Vec<u8>,
    instance: Option<[u8; 32]>,
    states: Vec<Vec<u8>>,
    deltas: Vec<Vec<u8>>,
    summaries: Vec<Vec<u8>>,
    transitions: Vec<Transition>,
    related: Vec<([u8; 32], Vec<u8>)>,
    note: Option<String>,
}

/// Mirror of `freenet::conformance::bundle::Transition`, schema 1.
#[derive(Serialize)]
struct Transition {
    base_state: Vec<u8>,
    delta: Option<Vec<u8>>,
    incoming_state: Option<Vec<u8>>,
    summary: Option<Vec<u8>>,
    result_state: Vec<u8>,
}

impl ReplayBundle {
    fn encode(&self) -> Result<Vec<u8>, bincode::Error> {
        let body = bincode::serialize(self)?;
        let mut out = Vec::with_capacity(BUNDLE_MAGIC.len() + 2 + body.len());
        out.extend_from_slice(BUNDLE_MAGIC);
        out.extend_from_slice(&BUNDLE_SCHEMA_VERSION.to_le_bytes());
        out.extend_from_slice(&body);
        Ok(out)
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let directory = args
        .next()
        .ok_or("usage: gen_corpus <output-directory> <contract-wasm>")?;
    let wasm_path = args
        .next()
        .ok_or("usage: gen_corpus <output-directory> <contract-wasm>")?;
    let directory = Path::new(&directory);
    std::fs::create_dir_all(directory)?;

    let wasm = std::fs::read(&wasm_path)?;
    let key = SigningKey::from_bytes(&CORPUS_SEED);
    let verifying = key.verifying_key();
    std::fs::write(directory.join("params.bin"), verifying.to_bytes())?;

    // Base board: one value, one measured value, one cleared slot.
    let s1 = StateV1::empty();
    let mut s2 = StateV1::empty();
    s2.slots[0] = signed(
        &key,
        0,
        1,
        Some(entry(
            12,
            Some("steps"),
            Some("count"),
            Some("morning walk"),
        )),
    );
    s2.slots[2] = signed(
        &key,
        2,
        3,
        Some(entry(-42, Some("weight"), Some("kg"), None)),
    );
    s2.slots[5] = signed(&key, 5, 1, None); // tombstone: a slot that was cleared

    // A later state from the same owner: higher seq on slot 0, an extreme i64 at
    // u64::MAX seq, and a longer note near the metadata limit.
    let mut s3 = s2.clone();
    s3.slots[0] = signed(
        &key,
        0,
        2,
        Some(entry(13, Some("steps"), Some("count"), Some("after lunch"))),
    );
    s3.slots[1] = signed(
        &key,
        1,
        u64::MAX,
        Some(entry(
            i64::MIN,
            Some("extreme"),
            Some("v"),
            Some(&"n".repeat(MAX_NOTE_BYTES)),
        )),
    );
    s3.slots[2] = signed(
        &key,
        2,
        4,
        Some(entry(-41, Some("weight"), Some("kg"), Some("re-measured"))),
    );

    // Three independent updates to the SAME base `s2`: the concurrent-update
    // scenario `delta_permutation_invariance` is a law about. Two add a slot, one
    // clears a slot with a tombstone.
    let mut a = s2.clone();
    a.slots[3] = signed(
        &key,
        3,
        1,
        Some(entry(100, Some("total"), Some("items"), None)),
    );
    let mut b = s2.clone();
    b.slots[4] = signed(&key, 4, 2, Some(entry(7, None, None, Some("concurrent"))));
    let mut c = s2.clone();
    c.slots[2] = signed(&key, 2, 5, None); // tombstone an existing slot

    // A second base with its own update, so transition provenance is not all one
    // board.
    let mut s4 = s3.clone();
    s4.slots[6] = signed(
        &key,
        6,
        2,
        Some(entry(-7, Some("delta"), None, Some("second base"))),
    );

    let states = [&s1, &s2, &s3, &a, &b, &c, &s4];
    for state in states {
        state.validate(&verifying)?;
    }

    let summaries: Vec<Vec<u8>> = states
        .iter()
        .map(|state| Summary::of(state).to_bytes())
        .collect();

    // Real network deltas: `get_state_delta(sender, recipient_summary)`.
    let d1 = delta(&verifying, &s2, &summaries[0]); // peer holds the empty board
    let da = delta(&verifying, &a, &summaries[1]); // peer is at s2
    let db = delta(&verifying, &b, &summaries[1]);
    let dc = delta(&verifying, &c, &summaries[1]);
    let d4 = delta(&verifying, &s4, &summaries[2]); // peer is at s3

    let transitions = vec![
        step(&verifying, &s1, &s2, d1, summaries[0].clone()),
        step(&verifying, &s2, &a, da, summaries[1].clone()),
        step(&verifying, &s2, &b, db, summaries[1].clone()),
        step(&verifying, &s2, &c, dc, summaries[1].clone()),
        step(&verifying, &s3, &s4, d4, summaries[2].clone()),
    ];

    let bundle = ReplayBundle {
        schema_version: BUNDLE_SCHEMA_VERSION,
        // The WASM is supplied to fdev by path; only its hash travels here.
        code: None,
        code_hash: Some(*blake3::hash(&wasm).as_bytes()),
        parameters: verifying.to_bytes().to_vec(),
        instance: None,
        states: states.iter().map(|state| state.to_bytes()).collect(),
        deltas: Vec::new(),
        summaries,
        transitions,
        related: Vec::new(),
        note: Some(
            "number verify-merge corpus: deterministic, generated by \
             contract/examples/gen_corpus.rs. States and deltas are produced by the \
             contract's own update path, so every merge law has material."
                .into(),
        ),
    };

    std::fs::write(directory.join("corpus.bundle"), bundle.encode()?)?;
    let delta_count = bundle
        .transitions
        .iter()
        .filter(|transition| transition.delta.is_some())
        .count();
    println!(
        "wrote corpus to {} ({} states, {} deltas, {} summaries, {} transitions; params pubkey {})",
        directory.display(),
        bundle.states.len(),
        delta_count,
        bundle.summaries.len(),
        bundle.transitions.len(),
        hex::encode(verifying.to_bytes())
    );
    Ok(())
}

/// A transition that has been re-applied: the result is what `base + delta`
/// actually produces, never a hand-written state.
fn step(
    verifying: &VerifyingKey,
    base: &StateV1,
    expected: &StateV1,
    delta: Vec<u8>,
    summary: Vec<u8>,
) -> Transition {
    let result = apply(verifying, base, &delta);
    assert_eq!(
        result.to_bytes(),
        expected.to_bytes(),
        "corpus delta does not reproduce the intended state"
    );
    // At-least-once delivery: re-applying must be a no-op.
    assert_eq!(
        apply(verifying, &result, &delta).to_bytes(),
        expected.to_bytes(),
        "corpus delta is not idempotent under the contract"
    );

    Transition {
        base_state: base.to_bytes(),
        delta: Some(delta),
        incoming_state: None,
        summary: Some(summary),
        result_state: result.to_bytes(),
    }
}

fn params(verifying: &VerifyingKey) -> Parameters<'static> {
    Parameters::from(verifying.to_bytes().to_vec())
}

fn delta(verifying: &VerifyingKey, sender: &StateV1, recipient_summary: &[u8]) -> Vec<u8> {
    NumberContract::get_state_delta(
        params(verifying),
        State::from(sender.to_bytes()),
        StateSummary::from(recipient_summary.to_vec()),
    )
    .expect("get_state_delta cannot fail for an in-memory state")
    .as_ref()
    .to_vec()
}

fn apply(verifying: &VerifyingKey, state: &StateV1, delta: &[u8]) -> StateV1 {
    let updated = NumberContract::update_state(
        params(verifying),
        State::from(state.to_bytes()),
        vec![UpdateData::Delta(StateDelta::from(delta.to_vec()))],
    )
    .expect("corpus delta must be accepted")
    .unwrap_valid();
    StateV1::decode(updated.as_ref()).expect("the contract emits decodable state")
}

fn signed(key: &SigningKey, index: u8, seq: u64, entry: Option<Entry>) -> Slot {
    let signature = key.sign(&signing_bytes(index, seq, entry.as_ref()));
    Slot {
        seq,
        entry,
        sig: Some(hex::encode(signature.to_bytes())),
    }
}

fn entry(value: i64, label: Option<&str>, unit: Option<&str>, note: Option<&str>) -> Entry {
    Entry {
        value,
        label: label.map(str::to_owned),
        unit: unit.map(str::to_owned),
        note: note.map(str::to_owned),
    }
}
