/**
 * User-facing identity backup codec.
 *
 * A backup is the delegate's Ed25519 seed plus its per-slot next-seq counters,
 * wrapped in a versioned JSON envelope so a paste from the wrong app or a
 * truncated file is rejected with a readable message instead of importing
 * nonsense. The seed is the owner's private key: anyone holding this code can
 * sign slot updates, so the UI must treat it as a secret.
 *
 * `pubkey` and `createdAt` are informational. The delegate validates the seed
 * and counters; it has no "derive the public key without importing" command, so
 * the UI cannot cross-check `pubkey` before importing. After a successful
 * import the UI shows the resulting identity, which is what the user compares
 * against the old device.
 */
import type { ExportedSecrets } from "./delegate";

export const IDENTITY_BACKUP_KIND = "number-identity";
export const IDENTITY_BACKUP_VERSION = 1;

const SEED_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface IdentityBackup {
  v: typeof IDENTITY_BACKUP_VERSION;
  kind: typeof IDENTITY_BACKUP_KIND;
  /** 32-byte Ed25519 seed, 64 lowercase hex characters. */
  seed: string;
  /** Per-slot next sequence values, 8 entries, each >= 1. */
  nextSeq: number[];
  /** Owner public key for human comparison; not verified at decode time. */
  pubkey?: string;
  /** ISO timestamp, informational. */
  createdAt?: string;
}

export interface DecodedIdentityBackup {
  seed: string;
  nextSeq: number[];
  pubkey?: string;
}

export class IdentityBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityBackupError";
  }
}

export function encodeIdentityBackup(
  secrets: ExportedSecrets,
  pubkey?: string,
  now: Date = new Date(),
): string {
  const backup: IdentityBackup = {
    v: IDENTITY_BACKUP_VERSION,
    kind: IDENTITY_BACKUP_KIND,
    seed: secrets.seed.toLowerCase(),
    nextSeq: [...secrets.nextSeq],
    ...(pubkey ? { pubkey: pubkey.toLowerCase() } : {}),
    createdAt: now.toISOString(),
  };
  return JSON.stringify(backup, null, 2);
}

export function decodeIdentityBackup(text: string): DecodedIdentityBackup {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new IdentityBackupError("Paste an identity backup first.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new IdentityBackupError(
      "That is not an identity backup: expected the JSON code this app exported.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IdentityBackupError("That is not an identity backup object.");
  }
  const record = parsed as Record<string, unknown>;

  if (
    record.kind !== IDENTITY_BACKUP_KIND ||
    record.v !== IDENTITY_BACKUP_VERSION
  ) {
    throw new IdentityBackupError(
      "That is not a version 1 number identity backup.",
    );
  }

  if (typeof record.seed !== "string" || !SEED_PATTERN.test(record.seed)) {
    throw new IdentityBackupError(
      "The backup seed must be 32 bytes of hex (64 characters).",
    );
  }

  const nextSeq = record.nextSeq;
  if (
    !Array.isArray(nextSeq) ||
    nextSeq.length !== 8 ||
    nextSeq.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1,
    )
  ) {
    throw new IdentityBackupError(
      "The backup sequence list must contain 8 positive integers.",
    );
  }

  let pubkey: string | undefined;
  if (record.pubkey !== undefined) {
    if (
      typeof record.pubkey !== "string" ||
      !SEED_PATTERN.test(record.pubkey)
    ) {
      throw new IdentityBackupError(
        "The backup public key must be 64 hex characters.",
      );
    }
    pubkey = record.pubkey.toLowerCase();
  }

  return {
    seed: record.seed.toLowerCase(),
    nextSeq: nextSeq as number[],
    ...(pubkey ? { pubkey } : {}),
  };
}

/** A stable, recognisable filename for a downloaded backup. */
export function identityBackupFilename(pubkey?: string): string {
  const suffix = pubkey ? `-${pubkey.slice(0, 8)}` : "";
  return `number-identity${suffix}.json`;
}
