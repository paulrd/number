/**
 * Address-book rules shared by every UI caller.
 *
 * The Rust delegate is the authority for these bounds; the UI repeats them so a
 * bad edit fails with a readable message before it reaches the wire. Keep the
 * problem helpers pure: callers wrap the returned string in their own error
 * class (`DelegateError`, `IdentityBackupError`, or a plain `Error`).
 */

import { isOctalAddress } from "./payments";
import { isLowerHex, utf8Length } from "./util";

/** One private address-book entry owned by the delegate (never replicated). */
export interface ContactRecord {
  /** 1–64 UTF-8 bytes; unique within the book. */
  label: string;
  /** 64 lowercase hex characters; unique within the book. */
  userId: string;
  /** Optional derived octal address used to route payments. */
  address: string | null;
}

export const MAX_CONTACT_LABEL_BYTES = 64;
export const MAX_CONTACTS = 64;
export const MAX_CONTACT_ADDRESS = 32;

/** Null when `value` is a legal contact label, otherwise the reason. */
export function contactLabelProblem(
  value: unknown,
  path: string,
): string | null {
  if (typeof value !== "string") {
    return `${path} must be a string.`;
  }
  if (value.length === 0) {
    return `${path} must not be empty.`;
  }
  const length = utf8Length(value);
  if (length > MAX_CONTACT_LABEL_BYTES) {
    return `${path} is ${length} bytes; maximum is ${MAX_CONTACT_LABEL_BYTES}.`;
  }
  return null;
}

/**
 * Null when `value` is absent (null/undefined) or a legal octal address,
 * otherwise the reason. An absent address is not an error.
 */
export function contactAddressValueProblem(
  value: unknown,
  path: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isOctalAddress(value)) {
    return `${path} must be null or an octal address of at most ${MAX_CONTACT_ADDRESS} digits 0..7.`;
  }
  return null;
}

/** Null when `raw` is a legal record, otherwise the reason. */
export function contactRecordProblem(
  raw: unknown,
  path: string,
): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${path} must be an object.`;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.userId !== "string" || !isLowerHex(obj.userId, 64)) {
    return `${path}.userId must be 64 lowercase hex characters.`;
  }
  return (
    contactLabelProblem(obj.label, `${path}.label`) ??
    contactAddressValueProblem(obj.address, `${path}.address`)
  );
}

/**
 * Null when `raw` is a legal address book, otherwise the reason. Checks shape,
 * size, each record, then duplicate userIds and labels.
 */
export function contactListProblem(
  raw: unknown,
  path: string,
): string | null {
  if (!Array.isArray(raw)) {
    return `${path} must be an array.`;
  }
  if (raw.length > MAX_CONTACTS) {
    return `${path} are limited to ${MAX_CONTACTS} entries (${raw.length} given).`;
  }
  const entries: ContactRecord[] = [];
  for (const [index, value] of raw.entries()) {
    const problem = contactRecordProblem(value, `${path}[${index}]`);
    if (problem) return problem;
    entries.push(normalizeContactRecord(value));
  }
  const userIds = new Set<string>();
  const labels = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (userIds.has(entry.userId)) {
      return `${path}[${index}] duplicates a userId.`;
    }
    userIds.add(entry.userId);
    if (labels.has(entry.label)) {
      return `${path}[${index}] duplicates a label.`;
    }
    labels.add(entry.label);
  }
  return null;
}

/**
 * Normalize one record that already passed `contactRecordProblem`; a missing
 * address becomes null. This does not validate.
 */
export function normalizeContactRecord(raw: unknown): ContactRecord {
  const record = raw as {
    label: string;
    userId: string;
    address?: string | null;
  };
  return {
    label: record.label,
    userId: record.userId,
    address: record.address ?? null,
  };
}

/**
 * Normalize a list that already passed `contactListProblem`; every missing
 * address becomes null. This does not validate.
 */
export function normalizeContactList(raw: unknown): ContactRecord[] {
  return (raw as unknown[]).map((entry) => normalizeContactRecord(entry));
}
