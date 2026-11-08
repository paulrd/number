/**
 * Ed25519 verification for portable credentials.
 *
 * Signing stays in the delegate; the browser only ever verifies. `@noble/ed25519`
 * is pure JavaScript, so it works inside the sandboxed, opaque-origin iframe
 * where WebCrypto's Ed25519 is not reliably available.
 *
 * `zip215: false` asks for the stricter RFC 8032 checks, approximating the
 * delegate's `verify_strict`. A divergence here could only be a permissive
 * verifier, never a forgery, and the delegate remains the signer of record.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

if (ed.etc.sha512Sync === undefined) {
  ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));
}

/** Verify `signature` over `message` with a raw 32-byte public key. */
export function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
