//! Regenerate the P3a golden vector. Run from `room/`:
//!
//! ```text
//! cargo run --example gen_golden > ../fixtures/rooms/golden_v1.json
//! ```
//!
//! The output is deterministic: the keys are fixed seeds and Ed25519 signing is
//! deterministic. P3b's TypeScript consumer must reproduce every pinned value
//! from the same inputs.

use ed25519_dalek::{Signer, SigningKey};
use number_room::{
    Membership, Message, Secret, State, membership_signing_bytes, message_signing_bytes,
    state_digest,
};
use serde_json::json;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn main() {
    let owner = key(7);
    let author = key(11);
    let owner_vk = owner.verifying_key();

    // Members sorted ascending, as the schema requires.
    let mut members = vec![
        hex::encode(owner_vk.to_bytes()),
        hex::encode(author.verifying_key().to_bytes()),
    ];
    members.sort();
    let blobs = [
        vec![0xde, 0xad, 0xbe, 0xef],
        vec![0x01, 0x02, 0x03, 0x04, 0x05],
    ];
    let secrets: Vec<Secret> = members
        .iter()
        .zip(blobs)
        .map(|(recipient, blob)| Secret {
            recipient: recipient.clone(),
            blob: hex::encode(blob),
        })
        .collect();

    let mut membership = Membership {
        seq: 3,
        members,
        secrets,
        sig: String::new(),
    };
    membership.sig = hex::encode(
        owner
            .sign(&membership_signing_bytes(&owner_vk, &membership))
            .to_bytes(),
    );

    let mut message = Message {
        author: hex::encode(author.verifying_key().to_bytes()),
        epoch: 3,
        seq: 7,
        time: 1_762_500_000_000,
        body: hex::encode(b"hello room"),
        sig: String::new(),
    };
    message.sig = hex::encode(
        author
            .sign(&message_signing_bytes(&owner_vk, &message))
            .to_bytes(),
    );

    let state = State {
        v: 1,
        memberships: vec![membership.clone()],
        messages: vec![message.clone()],
    };

    let fixture = json!({
        "description": "P3a members-room golden vector (DESIGN-rooms.md §3, §9.13)",
        "tag": "ZMR1",
        "owner_seed_hex": hex::encode([7u8; 32]),
        "author_seed_hex": hex::encode([11u8; 32]),
        "owner_vk_hex": hex::encode(owner_vk.to_bytes()),
        "membership": {
            "signing_bytes_hex": hex::encode(membership_signing_bytes(&owner_vk, &membership)),
            "sig_hex": membership.sig,
        },
        "message": {
            "signing_bytes_hex": hex::encode(message_signing_bytes(&owner_vk, &message)),
            "sig_hex": message.sig,
            "id": message.id(),
        },
        "state": state,
        "state_bytes_hex": hex::encode(state.to_bytes()),
        "digest": state_digest(&state),
    });
    println!("{}", serde_json::to_string_pretty(&fixture).unwrap());
}
