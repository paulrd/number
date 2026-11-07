//! Regenerate the P3c delegated-encryption golden vector. Run from `delegate/`:
//!
//! ```text
//! cargo run --example gen_golden_p3c > ../fixtures/rooms/golden_p3c.json
//! ```
//!
//! The output is deterministic: fixed seeds, a fixed byte-sequence RNG and a
//! fixed input. `SequenceRng` draws the epoch key first, then for each member in
//! ascending order an ephemeral seed (32 bytes) followed by a nonce (12 bytes).

use std::collections::BTreeMap;

use ed25519_dalek::{Signer, SigningKey};
use number_delegate::crypto::SequenceRng;
use number_delegate::{SECRET_SEED, SecretStore, room, seal_room_epoch_with};
use serde_json::json;

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

fn main() {
    let owner_seed = [7u8; 32];
    let author_seed = [11u8; 32];
    let owner = SigningKey::from_bytes(&owner_seed);
    let author = SigningKey::from_bytes(&author_seed);
    let owner_vk = hex::encode(owner.verifying_key().to_bytes());
    let author_vk = hex::encode(author.verifying_key().to_bytes());

    let room_id = "6RQvoNj3CQV2AWTruyuExE3gMcXyxWK2cmE47rPXowrV";
    let epoch = 5u64;
    let membership_seq = 4u64;

    let mut members = vec![author_vk.clone(), owner_vk.clone()];
    members.sort();

    let mut store = MemoryStore::default();
    assert!(store.set_secret(SECRET_SEED, &owner_seed));
    let (epoch_key, next_membership_seq, secrets) = seal_room_epoch_with(
        &store,
        room_id,
        &owner_vk,
        "ZMR1",
        epoch,
        &members,
        &mut SequenceRng::new(1),
    )
    .expect("golden seal succeeds");

    let membership_bytes =
        room::membership_signing_bytes("ZMR1", &owner_vk, membership_seq, &members, &secrets)
            .expect("golden membership bytes");
    let membership_sig = owner.sign(&membership_bytes);

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "description": "P3c delegated room encryption golden vector (DESIGN-rooms.md §7.3)",
            "tag": "ZMR1",
            "room_id": room_id,
            "owner_seed_hex": hex::encode(owner_seed),
            "owner_vk_hex": owner_vk,
            "author_seed_hex": hex::encode(author_seed),
            "author_vk_hex": author_vk,
            "epoch": epoch,
            "membership_seq": membership_seq,
            "members": members,
            "rng": {
                "kind": "sequence",
                "start": 1,
                "order": "epoch_key (32) then per member ascending: ephemeral_seed (32), nonce (12)",
            },
            "epoch_key_hex": hex::encode(epoch_key),
            "next_membership_seq": next_membership_seq,
            "secrets": secrets,
            "membership": {
                "signing_bytes_hex": hex::encode(&membership_bytes),
                "sig_hex": hex::encode(membership_sig.to_bytes()),
            },
        }))
        .unwrap()
    );
}
