import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "./board";
import { prospectiveRegion } from "./parent-region";
import { emptyState, type Entry, type StateV3 } from "./state";
import type { AddressInfo } from "./tree-view";

const SIG = "a".repeat(128);

function owner(name: string): string {
  // 64 lowercase hex chars; the value is only used as a map key here.
  return name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
}

function entry(contact: string, value = 0n): Entry {
  return { value, contact, unit: null, note: null };
}

/** A parent board with `children` written into the first slots. */
function board(
  name: string,
  children: Array<string | null> = [],
): BoardSnapshot {
  const state: StateV3 = emptyState();
  children.forEach((childName, index) => {
    if (childName === null) return;
    state.slots[index] = {
      seq: 1,
      entry: entry(owner(childName), BigInt(index + 1) * 100n),
      sig: SIG,
    };
  });
  return {
    ownerId: owner(name),
    state,
    contacts: [],
    codeHash: "contract",
    legacy: false,
  };
}

function settled(address: string): AddressInfo {
  return { address, problem: null, blockedBy: null };
}

describe("prospectiveRegion", () => {
  it("builds the child address from a root parent's slot", () => {
    const parent = board("parent", [null, null, "child"]);
    expect(prospectiveRegion(parent, settled(""), owner("child"))).toEqual({
      address: "2",
      slot: 2,
      digit: "2",
      cellLetter: "c",
      problem: null,
    });
  });

  it("appends the slot digit to a non-root parent address", () => {
    const parent = board("parent", [null, null, null, null, "child"]);
    expect(prospectiveRegion(parent, settled("12"), owner("child"))).toEqual({
      address: "124",
      slot: 4,
      digit: "4",
      cellLetter: "e",
      problem: null,
    });
  });

  it("reports an unsettled parent address", () => {
    const parent = board("parent", ["child"]);
    expect(
      prospectiveRegion(parent, {
        address: null,
        problem: "pending",
        blockedBy: parent.ownerId,
      }, owner("child")),
    ).toEqual({
      address: null,
      slot: null,
      digit: null,
      cellLetter: null,
      problem: "unsettled-parent",
    });
  });

  it("reports a parent that has not assigned a slot", () => {
    const parent = board("parent", [null, null, "someone-else"]);
    expect(
      prospectiveRegion(parent, settled(""), owner("child")),
    ).toEqual({
      address: null,
      slot: null,
      digit: null,
      cellLetter: null,
      problem: "no-slot",
    });
  });

  it("reports an unreadable parent and never throws", () => {
    expect(() =>
      prospectiveRegion(
        null,
        { address: null, problem: "unreadable", blockedBy: owner("parent") },
        owner("child"),
      ),
    ).not.toThrow();
    expect(
      prospectiveRegion(
        null,
        { address: null, problem: "unreadable", blockedBy: owner("parent") },
        owner("child"),
      ),
    ).toEqual({
      address: null,
      slot: null,
      digit: null,
      cellLetter: null,
      problem: "unreadable",
    });
  });

  it("reports no parent when the own id is unknown", () => {
    const parent = board("parent", ["child"]);
    expect(prospectiveRegion(parent, settled(""), null)).toEqual({
      address: null,
      slot: null,
      digit: null,
      cellLetter: null,
      problem: "no-parent",
    });
  });

  it("handles the first and last slot boundaries", () => {
    const child = owner("child");
    const first = board("parent", ["child"]);
    expect(prospectiveRegion(first, settled(""), child)).toMatchObject({
      address: "0",
      slot: 0,
      digit: "0",
      cellLetter: "a",
      problem: null,
    });

    const last = board("parent", [
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "child",
    ]);
    expect(prospectiveRegion(last, settled(""), child)).toMatchObject({
      address: "7",
      slot: 7,
      digit: "7",
      cellLetter: "h",
      problem: null,
    });
  });
});
