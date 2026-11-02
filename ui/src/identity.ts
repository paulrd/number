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
import {
  contactListProblem,
  normalizeContactList,
  type ContactRecord,
} from "./contact-rules";

export const IDENTITY_BACKUP_KIND = "number-identity";
/**
 * v2 carries the delegate's private address book (`payloadVersion: 2`) and the
 * signed-record counters a v1 payload predates: the v5 adjustment counter and
 * the two v6 name counters. v1 is still accepted on decode/import.
 */
export const IDENTITY_BACKUP_VERSION = 2;
export const LEGACY_IDENTITY_BACKUP_VERSION = 1;

const SEED_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface IdentityBackup {
  v: typeof IDENTITY_BACKUP_VERSION;
  kind: typeof IDENTITY_BACKUP_KIND;
  /** Delegate export payload version; v2 adds the address book. */
  payloadVersion: number;
  /** 32-byte Ed25519 seed, 64 lowercase hex characters. */
  seed: string;
  /** Per-slot next sequence values, 8 entries, each >= 1. */
  nextSeq: number[];
  /**
   * Next sequence value for the signed contacts record, >= 1. Optional so v1
   * backups (written before the address book existed) still decode; missing
   * means 1.
   */
  contactsNextSeq?: number;
  /**
   * Next sequence value for the signed parent record, >= 1. Optional so
   * backups written before the tree existed still decode; missing means 1.
   */
  parentNextSeq?: number;
  /**
   * Next sequence value for the signed payments record, >= 1. Optional so
   * backups written before cooperative payments still decode; missing means 1.
   */
  paymentsNextSeq?: number;
  /**
   * Next sequence value for the signed v5 `adjustments` record, >= 1. Optional
   * so backups written before issue/burn still decode; missing means 1.
   */
  adjustmentsNextSeq?: number;
  /**
   * Next sequence value for the signed v6 `childNames` record, >= 1. Optional
   * so backups written before v9 still decode; missing means 1.
   */
  childNamesNextSeq?: number;
  /**
   * Next sequence value for the signed v6 `selfName` record, >= 1. Optional so
   * backups written before v9 still decode; missing means 1.
   */
  selfNameNextSeq?: number;
  /** The private address book; empty for a v1 payload. */
  contacts?: ContactRecord[];
  /** Owner public key for human comparison; not verified at decode time. */
  pubkey?: string;
  /** ISO timestamp, informational. */
  createdAt?: string;
}

export interface DecodedIdentityBackup {
  /** 1 for a pre-v9 backup, 2 for a backup that carries the address book. */
  payloadVersion: number;
  seed: string;
  nextSeq: number[];
  /** Defaults to 1 for a v1 backup that has no contacts counter. */
  contactsNextSeq: number;
  /** Defaults to 1 for a backup written before the parent link existed. */
  parentNextSeq: number;
  /** Defaults to 1 for a backup written before payments existed. */
  paymentsNextSeq: number;
  /** Defaults to 1 for a backup written before issue/burn existed. */
  adjustmentsNextSeq: number;
  /** Defaults to 1 for a backup written before the v6 name records existed. */
  childNamesNextSeq: number;
  /** Defaults to 1 for a backup written before the v6 name records existed. */
  selfNameNextSeq: number;
  /** Empty for a v1 backup. */
  contacts: ContactRecord[];
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
    payloadVersion: secrets.payloadVersion ?? IDENTITY_BACKUP_VERSION,
    seed: secrets.seed.toLowerCase(),
    nextSeq: [...secrets.nextSeq],
    contactsNextSeq: secrets.contactsNextSeq,
    parentNextSeq: secrets.parentNextSeq,
    paymentsNextSeq: secrets.paymentsNextSeq ?? 1,
    adjustmentsNextSeq: secrets.adjustmentsNextSeq ?? 1,
    childNamesNextSeq: secrets.childNamesNextSeq ?? 1,
    selfNameNextSeq: secrets.selfNameNextSeq ?? 1,
    contacts: validateBackupContacts(secrets.contacts ?? []),
    ...(pubkey ? { pubkey: pubkey.toLowerCase() } : {}),
    createdAt: now.toISOString(),
  };
  return JSON.stringify(backup, null, 2);
}

/** Validate the address book carried by a backup (same bounds as delegate). */
function validateBackupContacts(raw: unknown): ContactRecord[] {
  const problem = contactListProblem(raw, "contacts");
  if (problem) throw new IdentityBackupError(`The backup ${problem}`);
  return normalizeContactList(raw);
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
    (record.v !== IDENTITY_BACKUP_VERSION &&
      record.v !== LEGACY_IDENTITY_BACKUP_VERSION)
  ) {
    throw new IdentityBackupError(
      "That is not a number identity backup (expected version 1 or 2).",
    );
  }
  const version =
    record.v === IDENTITY_BACKUP_VERSION
      ? IDENTITY_BACKUP_VERSION
      : LEGACY_IDENTITY_BACKUP_VERSION;

  let payloadVersion = version;
  if (record.payloadVersion !== undefined) {
    if (
      typeof record.payloadVersion !== "number" ||
      !Number.isSafeInteger(record.payloadVersion) ||
      (record.payloadVersion !== 1 && record.payloadVersion !== 2)
    ) {
      throw new IdentityBackupError(
        "The backup payload version must be 1 or 2.",
      );
    }
    payloadVersion = record.payloadVersion;
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

  let contactsNextSeq = 1;
  if (record.contactsNextSeq !== undefined) {
    if (
      typeof record.contactsNextSeq !== "number" ||
      !Number.isSafeInteger(record.contactsNextSeq) ||
      record.contactsNextSeq < 1
    ) {
      throw new IdentityBackupError(
        "The backup contacts sequence must be a positive integer.",
      );
    }
    contactsNextSeq = record.contactsNextSeq;
  }

  let parentNextSeq = 1;
  if (record.parentNextSeq !== undefined) {
    if (
      typeof record.parentNextSeq !== "number" ||
      !Number.isSafeInteger(record.parentNextSeq) ||
      record.parentNextSeq < 1
    ) {
      throw new IdentityBackupError(
        "The backup parent sequence must be a positive integer.",
      );
    }
    parentNextSeq = record.parentNextSeq;
  }

  let paymentsNextSeq = 1;
  if (record.paymentsNextSeq !== undefined) {
    if (
      typeof record.paymentsNextSeq !== "number" ||
      !Number.isSafeInteger(record.paymentsNextSeq) ||
      record.paymentsNextSeq < 1
    ) {
      throw new IdentityBackupError(
        "The backup payments sequence must be a positive integer.",
      );
    }
    paymentsNextSeq = record.paymentsNextSeq;
  }

  let adjustmentsNextSeq = 1;
  if (record.adjustmentsNextSeq !== undefined) {
    if (
      typeof record.adjustmentsNextSeq !== "number" ||
      !Number.isSafeInteger(record.adjustmentsNextSeq) ||
      record.adjustmentsNextSeq < 1
    ) {
      throw new IdentityBackupError(
        "The backup adjustments sequence must be a positive integer.",
      );
    }
    adjustmentsNextSeq = record.adjustmentsNextSeq;
  }

  let childNamesNextSeq = 1;
  if (record.childNamesNextSeq !== undefined) {
    if (
      typeof record.childNamesNextSeq !== "number" ||
      !Number.isSafeInteger(record.childNamesNextSeq) ||
      record.childNamesNextSeq < 1
    ) {
      throw new IdentityBackupError(
        "The backup childNames sequence must be a positive integer.",
      );
    }
    childNamesNextSeq = record.childNamesNextSeq;
  }

  let selfNameNextSeq = 1;
  if (record.selfNameNextSeq !== undefined) {
    if (
      typeof record.selfNameNextSeq !== "number" ||
      !Number.isSafeInteger(record.selfNameNextSeq) ||
      record.selfNameNextSeq < 1
    ) {
      throw new IdentityBackupError(
        "The backup selfName sequence must be a positive integer.",
      );
    }
    selfNameNextSeq = record.selfNameNextSeq;
  }

  const contacts =
    record.contacts === undefined ? [] : validateBackupContacts(record.contacts);

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
    payloadVersion,
    seed: record.seed.toLowerCase(),
    nextSeq: nextSeq as number[],
    contactsNextSeq,
    parentNextSeq,
    paymentsNextSeq,
    adjustmentsNextSeq,
    childNamesNextSeq,
    selfNameNextSeq,
    contacts,
    ...(pubkey ? { pubkey } : {}),
  };
}

/** A stable, recognisable filename for a downloaded backup. */
export function identityBackupFilename(pubkey?: string): string {
  const suffix = pubkey ? `-${pubkey.slice(0, 8)}` : "";
  return `number-identity${suffix}.json`;
}
