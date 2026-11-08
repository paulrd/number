/**
 * Pure interview and admission derivations (`DESIGN-candidates.md` §12.2.1).
 *
 * The requester queue and the candidate room are independent records; these
 * helpers join them so the requests panel and the candidate's pending surface
 * derive the same zone membership, active candidate, block reasons, admission
 * slot and child address. No DOM, transport or crypto lives here.
 */

import {
  CANDIDATE_MAX_MEMBERS,
  latestCandidateMembership,
  type CandidateStateV1,
} from "./candidate-state";
import { SLOT_COUNT, USER_ID_HEX_LEN, type StateV3 } from "./state";
import { isLowerHex } from "./util";

/**
 * Occupied slot contacts, deduped and ascending.
 *
 * `ownerId` is part of the shared signature. A slot naming the owner is odd
 * but not special here; `interviewMembers` dedupes it against the owner.
 */
export function zoneChildren(ownerId: string, state: StateV3): string[] {
  void ownerId;
  const children = new Set<string>();
  for (const slot of state.slots) {
    const contact = slot.entry?.contact;
    if (contact !== undefined) children.add(contact);
  }
  return [...children].sort();
}

/**
 * The candidate-room membership for an interview: owner, zone children and
 * the candidate, deduped and ascending. The caller enforces the 9-member
 * bound (`CANDIDATE_MAX_MEMBERS`).
 */
export function interviewMembers(
  ownerId: string,
  state: StateV3,
  candidate: string,
): string[] {
  return [...new Set([ownerId, ...zoneChildren(ownerId, state), candidate])].sort();
}

/** The latest candidate membership plus its single active candidate. */
export interface InterviewState {
  seq: number;
  members: string[];
  /** A member outside owner ∪ zone children; null when zero or several. */
  candidate: string | null;
}

/**
 * Derive the active interview from the latest candidate membership.
 *
 * The candidate is the single member outside `owner ∪ zoneChildren`. Zero or
 * more than one such member is a client-visible inconsistency: the record is
 * still returned, with `candidate: null`, so the caller can warn. The owner is
 * ignored even when a slot names it.
 */
export function interviewState(
  candidateState: CandidateStateV1 | null,
  zoneState: StateV3,
  ownerId: string,
): InterviewState | null {
  if (candidateState === null) return null;
  const membership = latestCandidateMembership(candidateState);
  if (membership === null) return null;

  const known = new Set([ownerId, ...zoneChildren(ownerId, zoneState)]);
  const outsiders = [
    ...new Set(membership.members.filter((member) => !known.has(member))),
  ];
  return {
    seq: membership.seq,
    members: [...membership.members],
    candidate: outsiders.length === 1 ? outsiders[0]! : null,
  };
}

/**
 * A readable reason the invite cannot start, or null when it may.
 *
 * Checks, in order: the id is a valid user key, the requester is already a
 * child, another candidate's round is active, and the zone is full (eight
 * children / more than nine members after adding the candidate).
 */
export function interviewBlockReason(
  candidateState: CandidateStateV1 | null,
  zoneState: StateV3,
  ownerId: string,
  candidate: string,
): string | null {
  if (!isLowerHex(candidate, USER_ID_HEX_LEN)) {
    return "That is not a valid user id.";
  }

  const children = zoneChildren(ownerId, zoneState);
  if (children.includes(candidate)) {
    return "They are already in this zone.";
  }

  const active = interviewState(candidateState, zoneState, ownerId);
  if (
    active !== null &&
    active.candidate !== null &&
    active.candidate !== candidate
  ) {
    return "An interview is already in progress.";
  }

  const members = interviewMembers(ownerId, zoneState, candidate);
  if (children.length >= SLOT_COUNT || members.length > CANDIDATE_MAX_MEMBERS) {
    return "This zone is full.";
  }

  return null;
}

/** First slot index whose entry contact is `candidateId`, or null. */
export function admissionSlot(
  zoneState: StateV3,
  candidateId: string,
): number | null {
  for (let index = 0; index < zoneState.slots.length; index += 1) {
    if (zoneState.slots[index]?.entry?.contact === candidateId) return index;
  }
  return null;
}

/** The child address a slot designates; a root address is just the digit. */
export function admissionAddress(ownAddress: string, slot: number): string {
  return `${ownAddress}${slot}`;
}

/**
 * The §3.5 refusal for admitting into a zone that already has a parent or
 * children, or null when the candidate's zone may join.
 */
export function admissionBlockReason(ownState: StateV3): string | null {
  const hasParent = ownState.parent.userId !== null;
  const hasChild = ownState.slots.some((slot) => slot.entry !== null);
  if (!hasParent && !hasChild) return null;
  return "Your zone already has a parent or children. Admission would move a subtree, which is not supported yet.";
}
