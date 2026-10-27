//! Generate a deterministic corpus for `fdev verify-merge`.
//!
//! Usage:
//!
//! ```text
//! cargo run --example gen_corpus -- /tmp/opencode/number-corpus
//! ```
//!
//! Writes `params.bin` (the raw 32-byte Ed25519 verifying key) and three valid
//! JSON states `s1.bin`, `s2.bin`, `s3.bin`. The signing key is a fixed seed so
//! the corpus is reproducible.

use std::error::Error;
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use number_contract::{Entry, MAX_NOTE_BYTES, Slot, StateV1, signing_bytes};

/// Fixed Ed25519 seed; must never be used outside this example/corpus.
const CORPUS_SEED: [u8; 32] = [0x42; 32];

fn main() -> Result<(), Box<dyn Error>> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("usage: gen_corpus <output-directory>")?;
    let directory = Path::new(&directory);
    std::fs::create_dir_all(directory)?;

    let key = SigningKey::from_bytes(&CORPUS_SEED);
    std::fs::write(directory.join("params.bin"), key.verifying_key().to_bytes())?;

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

    // s3 is a later state from the same owner: higher seq on slot 0, a new slot
    // and a longer note near the metadata limit.
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

    let verifying = key.verifying_key();
    for (name, state) in [("s1.bin", &s1), ("s2.bin", &s2), ("s3.bin", &s3)] {
        state.validate(&verifying)?;
        std::fs::write(directory.join(name), state.to_bytes())?;
    }

    println!(
        "wrote corpus to {} (params pubkey {})",
        directory.display(),
        hex::encode(verifying.to_bytes())
    );
    Ok(())
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
