//! Regenerate the P4a golden vector. Run from `candidate/`:
//!
//! ```text
//! cargo run --example gen_golden > ../fixtures/candidate/golden_v1.json
//! ```
//!
//! The output is deterministic: the keys are fixed seeds and Ed25519 signing is
//! deterministic. The fixture pins the request, dismissal and config vectors
//! plus the members-room membership and message records reused under `ZCR1`.

use ed25519_dalek::{Signer, SigningKey};
use number_candidate::{
    Config, Dismissal, Membership, Message, Request, Secret, State, config_signing_bytes,
    dismissal_signing_bytes, membership_signing_bytes, message_signing_bytes,
    request_signing_bytes, state_digest,
};
use serde_json::json;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn main() {
    let owner = key(7);
    let author = key(11);
    let requester = key(33);
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
        body: hex::encode(b"hello candidate room"),
        sig: String::new(),
    };
    message.sig = hex::encode(
        author
            .sign(&message_signing_bytes(&owner_vk, &message))
            .to_bytes(),
    );

    let mut request = Request {
        requester: hex::encode(requester.verifying_key().to_bytes()),
        want_cell: "003".into(),
        time: 1_762_500_000_001,
        note: hex::encode(b"let me in"),
        sig: String::new(),
    };
    request.sig = hex::encode(
        requester
            .sign(&request_signing_bytes(&owner_vk, &request))
            .to_bytes(),
    );

    let mut dismissal = Dismissal {
        id: request.id(),
        sig: String::new(),
    };
    dismissal.sig = hex::encode(
        owner
            .sign(&dismissal_signing_bytes(&owner_vk, &dismissal.id))
            .to_bytes(),
    );

    let mut config = Config {
        seq: 1,
        accepting: true,
        sig: String::new(),
    };
    config.sig = hex::encode(
        owner
            .sign(&config_signing_bytes(&owner_vk, &config))
            .to_bytes(),
    );

    // The dismissal is a standalone vector: a state carrying both a request and
    // its dismissal is invalid, so it is not part of `state`.
    let state = State {
        v: 1,
        memberships: vec![membership.clone()],
        messages: vec![message.clone()],
        requests: vec![request.clone()],
        dismissals: Vec::new(),
        config: Some(config.clone()),
    };

    let fixture = json!({
        "description": "P4a candidates-room golden vector (DESIGN-candidates.md §3, §9.16)",
        "tag": "ZCR1",
        "owner_seed_hex": hex::encode([7u8; 32]),
        "author_seed_hex": hex::encode([11u8; 32]),
        "requester_seed_hex": hex::encode([33u8; 32]),
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
        "request": {
            "signing_bytes_hex": hex::encode(request_signing_bytes(&owner_vk, &request)),
            "sig_hex": request.sig,
            "id": request.id(),
        },
        "dismissal": {
            "signing_bytes_hex": hex::encode(dismissal_signing_bytes(
                &owner_vk,
                &dismissal.id,
            )),
            "id": dismissal.id,
            "sig_hex": dismissal.sig,
        },
        "config": {
            "signing_bytes_hex": hex::encode(config_signing_bytes(&owner_vk, &config)),
            "sig_hex": config.sig,
        },
        "state": state,
        "state_bytes_hex": hex::encode(state.to_bytes()),
        "digest": state_digest(&state),
    });
    println!("{}", serde_json::to_string_pretty(&fixture).unwrap());
}
