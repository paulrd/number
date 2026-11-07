//! Delegated members-room encryption (`DESIGN-rooms.md` §7.1–§7.3).
//!
//! The delegate owns the owner seed. The UI never sees it; it asks the delegate
//! to seal a fresh epoch key to every member and to open the one blob addressed
//! to this delegate. Keys are never persisted or exported.
//!
//! This module implements exactly the frozen formats:
//!
//! - Ed25519 → X25519 public: `u = (1 + y) / (1 − y)` (via
//!   `ed25519-dalek`'s `VerifyingKey::to_montgomery`), with weak/low-order
//!   points and `u = 0` rejected.
//! - Ed25519 → X25519 private: `clamp(SHA-512(seed)[0..32])`, matching
//!   libsodium's `crypto_sign_ed25519_sk_to_curve25519`.
//! - HKDF-SHA256 with `salt = eph_pk || recipient_u` and
//!   `info = "number:v1:room:secret" || "ZMR1" || roomId || owner ||
//!   epoch_le || recipient`, where `recipient_u` is the converted X25519
//!   public key and `recipient` is the original Ed25519 public key.
//! - AES-256-GCM over the 32-byte epoch key, with
//!   `aad = version || eph_pk || nonce`.
//!
//! The production RNG is [`DelegateRng`], backed by the host's
//! `freenet_stdlib::rand`. Tests and the golden fixture use [`SequenceRng`],
//! which is deterministic and must never be used in production.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256, Sha512};
use x25519_dalek::{PublicKey, StaticSecret};

/// Version byte of the 93-byte secret blob.
pub const SECRET_BLOB_VERSION: u8 = 1;
/// Exact encoded length of one epoch-secret blob.
pub const SECRET_BLOB_LEN: usize = 93;
/// Length of the epoch key.
pub const EPOCH_KEY_LEN: usize = 32;

const X25519_PUBLIC_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const AEAD_TAG_LEN: usize = 16;
const EPH_OFFSET: usize = 1;
const NONCE_OFFSET: usize = EPH_OFFSET + X25519_PUBLIC_LEN; // 33
const CIPHERTEXT_OFFSET: usize = NONCE_OFFSET + NONCE_LEN; // 45
/// 32-byte epoch key plus the 16-byte GCM tag.
const SEALED_KEY_LEN: usize = EPOCH_KEY_LEN + AEAD_TAG_LEN; // 48

/// Domain separator for the epoch-secret KDF (`DESIGN-rooms.md` §7.3).
pub const SECRET_INFO_PREFIX: &[u8] = b"number:v1:room:secret";

/// Host randomness used for ephemeral X25519 keys, nonces and epoch keys.
pub trait RngSource {
    fn fill_bytes(&mut self, dest: &mut [u8]);
}

/// Production RNG: the delegate host's random source.
pub struct DelegateRng;

impl RngSource for DelegateRng {
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        // The host function caps one call at 512 bytes; chunk larger requests.
        for chunk in dest.chunks_mut(512) {
            let bytes = freenet_stdlib::rand::rand_bytes(chunk.len() as u32);
            chunk.copy_from_slice(&bytes);
        }
    }
}

/// Deterministic byte-sequence RNG for tests and the golden fixture only.
///
/// The first byte is `start`, then each subsequent byte increments by one
/// (wrapping at 255). This is not cryptographic and must never be selected by
/// production code.
pub struct SequenceRng {
    next: u8,
}

impl SequenceRng {
    pub fn new(start: u8) -> Self {
        Self { next: start }
    }
}

impl RngSource for SequenceRng {
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        for byte in dest {
            *byte = self.next;
            self.next = self.next.wrapping_add(1);
        }
    }
}

/// Convert an Ed25519 verifying key to its X25519 Montgomery `u` coordinate.
///
/// Rejects low-order/weak points (including the identity) and `u = 0`.
pub fn ed25519_public_to_x25519(key: &VerifyingKey) -> Result<[u8; 32], String> {
    if key.is_weak() {
        return Err("recipient key is a weak/low-order Ed25519 point".into());
    }
    let u = key.to_montgomery().to_bytes();
    if u == [0u8; 32] {
        return Err("recipient key maps to the identity X25519 point".into());
    }
    Ok(u)
}

/// Convert an Ed25519 seed to the libsodium-compatible X25519 private scalar:
/// `clamp(SHA-512(seed)[0..32])`.
pub fn ed25519_seed_to_x25519(seed: &[u8; 32]) -> [u8; 32] {
    let digest = Sha512::digest(seed);
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&digest[..32]);
    clamp_scalar(&mut scalar);
    scalar
}

fn clamp_scalar(scalar: &mut [u8; 32]) {
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;
}

/// The X25519 public key corresponding to an Ed25519 seed.
pub fn ed25519_seed_to_x25519_public(seed: &[u8; 32]) -> [u8; 32] {
    let secret = StaticSecret::from(ed25519_seed_to_x25519(seed));
    PublicKey::from(&secret).to_bytes()
}

fn secret_info(room_id: &[u8; 32], owner: &[u8; 32], epoch: u64, recipient: &[u8; 32]) -> Vec<u8> {
    let mut info = Vec::with_capacity(SECRET_INFO_PREFIX.len() + 4 + 32 + 32 + 8 + 32);
    info.extend_from_slice(SECRET_INFO_PREFIX);
    info.extend_from_slice(crate::room::ROOM_TAG.as_bytes());
    info.extend_from_slice(room_id);
    info.extend_from_slice(owner);
    info.extend_from_slice(&epoch.to_le_bytes());
    info.extend_from_slice(recipient);
    info
}

fn derive_secret_key(
    shared: &[u8; 32],
    eph_public: &[u8; 32],
    recipient: &[u8; 32],
    recipient_u: &[u8; 32],
    room_id: &[u8; 32],
    owner: &[u8; 32],
    epoch: u64,
) -> Result<[u8; 32], String> {
    let mut salt = [0u8; X25519_PUBLIC_LEN * 2];
    salt[..X25519_PUBLIC_LEN].copy_from_slice(eph_public);
    salt[X25519_PUBLIC_LEN..].copy_from_slice(recipient_u);
    let info = secret_info(room_id, owner, epoch, recipient);

    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut key = [0u8; 32];
    hkdf.expand(&info, &mut key)
        .map_err(|_| "HKDF failed to derive the secret blob key".to_string())?;
    Ok(key)
}

/// Seal one 32-byte epoch key to `recipient` (an Ed25519 verifying key).
///
/// `room_id` and `owner` are raw 32-byte values. A fresh ephemeral X25519 key
/// and nonce are drawn from `rng` for every call, so every recipient gets an
/// independent 93-byte blob.
pub fn seal_with_rng(
    room_id: &[u8; 32],
    owner: &[u8; 32],
    epoch: u64,
    recipient: &[u8; 32],
    epoch_key: &[u8; EPOCH_KEY_LEN],
    rng: &mut impl RngSource,
) -> Result<[u8; SECRET_BLOB_LEN], String> {
    if epoch == 0 {
        return Err("room epoch must be greater than 0".into());
    }
    let recipient_key = VerifyingKey::from_bytes(recipient)
        .map_err(|_| "recipient is not a valid Ed25519 point".to_string())?;
    let recipient_u = ed25519_public_to_x25519(&recipient_key)?;

    let mut ephemeral_seed = [0u8; 32];
    rng.fill_bytes(&mut ephemeral_seed);
    let ephemeral_secret = StaticSecret::from(ephemeral_seed);
    let ephemeral_public = PublicKey::from(&ephemeral_secret).to_bytes();

    let shared = ephemeral_secret.diffie_hellman(&PublicKey::from(recipient_u));
    if shared.as_bytes() == &[0u8; 32] {
        return Err("refused to seal to a recipient with an all-zero shared secret".into());
    }

    let key = derive_secret_key(
        shared.as_bytes(),
        &ephemeral_public,
        recipient,
        &recipient_u,
        room_id,
        owner,
        epoch,
    )?;

    let mut nonce = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut nonce);

    let mut aad = [0u8; 1 + X25519_PUBLIC_LEN + NONCE_LEN];
    aad[0] = SECRET_BLOB_VERSION;
    aad[1..1 + X25519_PUBLIC_LEN].copy_from_slice(&ephemeral_public);
    aad[1 + X25519_PUBLIC_LEN..].copy_from_slice(&nonce);

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "failed to initialise AES-256-GCM".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: epoch_key,
                aad: &aad,
            },
        )
        .map_err(|_| "failed to seal the epoch key".to_string())?;
    if ciphertext.len() != SEALED_KEY_LEN {
        return Err("sealed epoch key has an unexpected length".into());
    }

    let mut blob = [0u8; SECRET_BLOB_LEN];
    blob[0] = SECRET_BLOB_VERSION;
    blob[EPH_OFFSET..NONCE_OFFSET].copy_from_slice(&ephemeral_public);
    blob[NONCE_OFFSET..CIPHERTEXT_OFFSET].copy_from_slice(&nonce);
    blob[CIPHERTEXT_OFFSET..].copy_from_slice(&ciphertext);
    Ok(blob)
}

/// Open a 93-byte epoch-secret blob addressed to `recipient_seed`.
///
/// Returns the epoch key. Every input is authenticated: the version byte,
/// ephemeral key and nonce are the AEAD associated data; the room id, owner,
/// epoch and recipient are bound into the HKDF info. A blob sealed for another
/// member, room, owner or epoch fails to open.
pub fn open(
    room_id: &[u8; 32],
    owner: &[u8; 32],
    epoch: u64,
    recipient_seed: &[u8; 32],
    blob: &[u8],
) -> Result<[u8; EPOCH_KEY_LEN], String> {
    if epoch == 0 {
        return Err("room epoch must be greater than 0".into());
    }
    if blob.len() != SECRET_BLOB_LEN {
        return Err(format!(
            "room secret blob must be exactly {SECRET_BLOB_LEN} bytes, got {}",
            blob.len()
        ));
    }
    if blob[0] != SECRET_BLOB_VERSION {
        return Err(format!(
            "unsupported room secret blob version {}, expect {SECRET_BLOB_VERSION}",
            blob[0]
        ));
    }

    let mut ephemeral_public = [0u8; X25519_PUBLIC_LEN];
    ephemeral_public.copy_from_slice(&blob[EPH_OFFSET..NONCE_OFFSET]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&blob[NONCE_OFFSET..CIPHERTEXT_OFFSET]);
    let ciphertext = &blob[CIPHERTEXT_OFFSET..];

    let recipient_scalar = ed25519_seed_to_x25519(recipient_seed);
    let recipient_u = ed25519_seed_to_x25519_public(recipient_seed);
    let recipient_ed25519 = SigningKey::from_bytes(recipient_seed)
        .verifying_key()
        .to_bytes();
    let recipient_secret = StaticSecret::from(recipient_scalar);
    let shared = recipient_secret.diffie_hellman(&PublicKey::from(ephemeral_public));
    if shared.as_bytes() == &[0u8; 32] {
        return Err("refused to open a blob with an all-zero shared secret".into());
    }

    let key = derive_secret_key(
        shared.as_bytes(),
        &ephemeral_public,
        &recipient_ed25519,
        &recipient_u,
        room_id,
        owner,
        epoch,
    )?;

    let mut aad = [0u8; 1 + X25519_PUBLIC_LEN + NONCE_LEN];
    aad[0] = SECRET_BLOB_VERSION;
    aad[1..1 + X25519_PUBLIC_LEN].copy_from_slice(&ephemeral_public);
    aad[1 + X25519_PUBLIC_LEN..].copy_from_slice(&nonce);

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "failed to initialise AES-256-GCM".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| {
            "failed to open room secret: wrong recipient, room, owner, epoch or corrupted blob"
                .to_string()
        })?;

    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| "opened room secret has an unexpected length".to_string())
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::*;

    // libsodium `test/default/ed25519_convert.c` seed, with the derived
    // Ed25519 public key and the outputs of
    // `crypto_sign_ed25519_sk_to_curve25519` / `crypto_sign_ed25519_pk_to_curve25519`.
    const LIBSODIUM_SEED: &str = "421151a459faeade3d247115f94aedae42318124095afabe4d1451a559faedee";
    const LIBSODIUM_ED_PUBLIC: &str =
        "b5076a8474a832daee4dd5b4040983b6623b5f344aca57d4d6ee4baf3f259e6e";
    const LIBSODIUM_X_SECRET: &str =
        "8052030376d47112be7f73ed7a019293dd12ad910b654455798b4667d73de166";
    const LIBSODIUM_X_PUBLIC: &str =
        "f1814f0e8ff1043d8a44d25babff3cedcae6c22c3edaa48f857ae70de2baae50";

    const ROOM_ID: [u8; 32] = [0x11; 32];
    const OWNER: [u8; 32] = [0x22; 32];
    const EPOCH: u64 = 7;
    const EPOCH_KEY: [u8; 32] = [0x33; 32];

    fn bytes32(hex: &str) -> [u8; 32] {
        hex::decode(hex).unwrap().try_into().unwrap()
    }

    fn member(seed_byte: u8) -> (SigningKey, [u8; 32]) {
        let key = SigningKey::from_bytes(&[seed_byte; 32]);
        let public = key.verifying_key().to_bytes();
        (key, public)
    }

    #[test]
    fn libsodium_ed25519_to_x25519_vector() {
        let seed = bytes32(LIBSODIUM_SEED);
        assert_eq!(
            SigningKey::from_bytes(&seed).verifying_key().to_bytes(),
            bytes32(LIBSODIUM_ED_PUBLIC)
        );

        // Private: clamp(SHA-512(seed)[0..32]).
        assert_eq!(ed25519_seed_to_x25519(&seed), bytes32(LIBSODIUM_X_SECRET));
        // The matching X25519 public key.
        assert_eq!(
            ed25519_seed_to_x25519_public(&seed),
            bytes32(LIBSODIUM_X_PUBLIC)
        );
        // Public: u = (1+y)/(1-y) via Ed25519 point decompression.
        let verifying = SigningKey::from_bytes(&seed).verifying_key();
        assert_eq!(
            ed25519_public_to_x25519(&verifying).unwrap(),
            bytes32(LIBSODIUM_X_PUBLIC)
        );
    }

    #[test]
    fn weak_and_identity_keys_are_rejected() {
        let identity = VerifyingKey::from_bytes(&{
            let mut bytes = [0u8; 32];
            bytes[0] = 1;
            bytes
        })
        .expect("identity is a valid compressed point");
        assert!(identity.is_weak());
        assert!(ed25519_public_to_x25519(&identity).is_err());

        // Order-2 point `y = -1`, i.e. p - 1, is also weak.
        let mut order_two = [0xffu8; 32];
        order_two[0] = 0xec;
        order_two[31] = 0x7f;
        if let Ok(key) = VerifyingKey::from_bytes(&order_two) {
            assert!(ed25519_public_to_x25519(&key).is_err());
        }

        // Sealing to a weak recipient fails rather than deriving a usable key.
        assert!(
            seal_with_rng(
                &ROOM_ID,
                &OWNER,
                EPOCH,
                &identity.to_bytes(),
                &EPOCH_KEY,
                &mut SequenceRng::new(1),
            )
            .is_err()
        );
    }

    #[test]
    fn seal_open_round_trip_for_each_recipient() {
        for count in [1usize, 2, 9] {
            let members: Vec<_> = (1..=count as u8).map(member).collect();
            let mut rng = SequenceRng::new(1);
            let mut blobs = Vec::new();
            for (_, public) in &members {
                blobs.push(
                    seal_with_rng(&ROOM_ID, &OWNER, EPOCH, public, &EPOCH_KEY, &mut rng).unwrap(),
                );
            }
            assert!(blobs.iter().all(|blob| blob.len() == SECRET_BLOB_LEN));
            // Every blob is independently randomised, even for the same key.
            assert!(blobs.windows(2).all(|pair| pair[0] != pair[1]));

            for (index, (key, _)) in members.iter().enumerate() {
                let opened = open(&ROOM_ID, &OWNER, EPOCH, &key.to_bytes(), &blobs[index]).unwrap();
                assert_eq!(opened, EPOCH_KEY);

                // A member can only open their own blob.
                if members.len() > 1 {
                    let (other_key, _) = &members[(index + 1) % members.len()];
                    assert!(
                        open(
                            &ROOM_ID,
                            &OWNER,
                            EPOCH,
                            &other_key.to_bytes(),
                            &blobs[index]
                        )
                        .is_err()
                    );
                }
            }
        }
    }

    #[test]
    fn open_binds_room_owner_epoch_and_blob_bytes() {
        let (key, public) = member(5);
        let blob = seal_with_rng(
            &ROOM_ID,
            &OWNER,
            EPOCH,
            &public,
            &EPOCH_KEY,
            &mut SequenceRng::new(9),
        )
        .unwrap();

        assert!(open(&[0x12; 32], &OWNER, EPOCH, &key.to_bytes(), &blob).is_err());
        assert!(open(&ROOM_ID, &[0x23; 32], EPOCH, &key.to_bytes(), &blob).is_err());
        assert!(open(&ROOM_ID, &OWNER, EPOCH + 1, &key.to_bytes(), &blob).is_err());

        for index in 0..blob.len() {
            let mut tampered = blob;
            tampered[index] ^= 0x01;
            assert!(
                open(&ROOM_ID, &OWNER, EPOCH, &key.to_bytes(), &tampered).is_err(),
                "tampering byte {index} should fail"
            );
        }

        assert!(open(&ROOM_ID, &OWNER, EPOCH, &key.to_bytes(), &blob[..92]).is_err());
        let mut oversized = blob.to_vec();
        oversized.push(0);
        assert!(open(&ROOM_ID, &OWNER, EPOCH, &key.to_bytes(), &oversized).is_err());
    }

    #[test]
    fn blob_layout_is_frozen() {
        let (key, public) = member(5);
        let blob = seal_with_rng(
            &ROOM_ID,
            &OWNER,
            EPOCH,
            &public,
            &EPOCH_KEY,
            &mut SequenceRng::new(1),
        )
        .unwrap();
        assert_eq!(blob.len(), 93);
        assert_eq!(blob[0], 1);
        // The first 32 bytes of the deterministic stream are the ephemeral seed,
        // clamped and multiplied by the X25519 base point.
        let ephemeral = StaticSecret::from({
            let mut seed = [0u8; 32];
            SequenceRng::new(1).fill_bytes(&mut seed);
            seed
        });
        assert_eq!(&blob[1..33], PublicKey::from(&ephemeral).as_bytes());
        // Next 12 bytes are the nonce.
        let mut nonce = [0u8; 12];
        SequenceRng::new(33).fill_bytes(&mut nonce);
        assert_eq!(&blob[33..45], &nonce);
        assert!(open(&ROOM_ID, &OWNER, EPOCH, &key.to_bytes(), &blob).is_ok());
    }
}
