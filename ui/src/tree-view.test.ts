import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "./board";
import { emptyState, type Entry, type StateV3 } from "./state";
import {
  childSlotIndex,
  octalAddress,
  parentValueFor,
  type LinkDeps,
} from "./tree-view";

const SIG = "a".repeat(128);

function owner(name: string): string {
  // 64 lowercase hex chars; the value is only used as a map key here.
  return name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
}

function entry(contact: string, value = 0n): Entry {
  return { value, contact, unit: null, note: null };
}

/**
 * Build a snapshot with one parent link and, for each entry in `children`, a
 * slot pointing at that child. Slot positions are the array indexes.
 */
function board(
  name: string,
  parentName: string | null,
  children: Array<string | null> = [],
): BoardSnapshot {
  const state: StateV3 = emptyState();
  state.parent.userId = parentName === null ? null : owner(parentName);
  children.forEach((childName, index) => {
    if (childName === null) return;
    const slotEntry = entry(owner(childName), BigInt(index + 1) * 100n);
    state.slots[index] = { seq: 1, entry: slotEntry, sig: SIG };
  });
  return {
    ownerId: owner(name),
    state,
    codeHash: "contract",
    legacy: false,
  };
}

function depsOf(...boards: BoardSnapshot[]): LinkDeps {
  const byOwner = new Map(boards.map((item) => [item.ownerId, item]));
  return {
    readBoard: async (ownerId) => byOwner.get(ownerId) ?? null,
  };
}

describe("childSlotIndex", () => {
  it("uses zero-based slot indexes", () => {
    const parent = board("p", null, ["a", null, "b"]);
    expect(childSlotIndex(parent.state, owner("a"))).toBe(0);
    expect(childSlotIndex(parent.state, owner("b"))).toBe(2);
    expect(childSlotIndex(parent.state, owner("c"))).toBeNull();
  });
});

describe("octalAddress", () => {
  it("gives a root the empty string", async () => {
    const root = board("root", null);
    await expect(octalAddress(root, depsOf(root))).resolves.toEqual({
      address: "",
      problem: null,
      blockedBy: null,
    });
  });

  it("appends the parent's zero-based slot digit", async () => {
    const root = board("root", null, ["child"]);
    const child = board("child", "root");
    await expect(octalAddress(child, depsOf(root, child))).resolves.toEqual({
      address: "0",
      problem: null,
      blockedBy: null,
    });

    const rootWithSlotSeven = board("root", null, [
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "child",
    ]);
    await expect(
      octalAddress(child, depsOf(rootWithSlotSeven, child)),
    ).resolves.toEqual({ address: "7", problem: null, blockedBy: null });
  });

  it("prefixes every ancestor's digit, root first", async () => {
    // root --slot 2--> middle --slot 5--> leaf
    const root = board("root", null, [null, null, "middle"]);
    const middle = board("middle", "root", [null, null, null, null, null, "leaf"]);
    const leaf = board("leaf", "middle");
    const deps = depsOf(root, middle, leaf);

    await expect(octalAddress(middle, deps)).resolves.toEqual({
      address: "2",
      problem: null,
      blockedBy: null,
    });
    await expect(octalAddress(leaf, deps)).resolves.toEqual({
      address: "25",
      problem: null,
      blockedBy: null,
    });
  });

  it("does not settle an address on a one-sided link", async () => {
    const parent = board("parent", null);
    const child = board("child", "parent");
    await expect(octalAddress(child, depsOf(parent, child))).resolves.toEqual({
      address: null,
      problem: "pending",
      blockedBy: parent.ownerId,
    });
  });

  it("reports a missing, unreadable, or looping ancestor", async () => {
    const orphan = board("orphan", "ghost");
    await expect(octalAddress(orphan, depsOf(orphan))).resolves.toEqual({
      address: null,
      problem: "not-created",
      blockedBy: owner("ghost"),
    });

    const unreadable: LinkDeps = {
      readBoard: async () => {
        throw new Error("offline");
      },
    };
    await expect(octalAddress(orphan, unreadable)).resolves.toMatchObject({
      address: null,
      problem: "unreadable",
    });

    // A and B point at each other; B does list A, so the loop is reached only
    // after a valid digit is collected.
    const a = board("a", "b", ["b"]);
    const b = board("b", "a", ["a"]);
    await expect(octalAddress(a, depsOf(a, b))).resolves.toEqual({
      address: null,
      problem: "loop",
      blockedBy: a.ownerId,
    });
  });

  it("treats a legacy parent as the root of a readable chain", async () => {
    const legacy = board("legacy", null, ["child"]);
    legacy.legacy = true;
    const child = board("child", "legacy");
    await expect(octalAddress(child, depsOf(legacy, child))).resolves.toEqual({
      address: "0",
      problem: null,
      blockedBy: null,
    });
  });
});

describe("parentValueFor", () => {
  it("returns the parent's slot value for the child", () => {
    const parent = board("parent", null, [null, "child"]);
    const value = parentValueFor(parent, owner("child"));
    expect(value).toMatchObject({
      slot: 1,
      parentOwnerId: parent.ownerId,
      entry: { value: 200n, contact: owner("child") },
    });
  });

  it("returns null when the parent holds no value for the child", () => {
    const parent = board("parent", null);
    expect(parentValueFor(parent, owner("child"))).toBeNull();
  });
});
