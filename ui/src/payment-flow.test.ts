import { blake3 } from "@noble/hashes/blake3";
import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "./board";
import {
  advancePayment,
  createPaymentIntent,
  paymentId,
  findIncoming,
  paymentProgress,
  planPayment,
  withdrawPayment,
  type PaymentDeps,
  type PaymentEntry,
  type PaymentPlan,
  type PaymentSlotWrite,
} from "./payments";
import { emptyPayments, emptyState, type Entry, type StateV3 } from "./state";
import { bytesToHex } from "./util";
import {
  contactAddressLabel,
  contactAddressProblem,
  contactUpdatePatch,
  parseReceiveInvite,
  recipientAddressLine,
  resolveReceiveInvite,
} from "./contacts-dialog";

const encoder = new TextEncoder();

function owner(name: string): string {
  return name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
}

function sig(label: string): string {
  return (
    bytesToHex(blake3(encoder.encode(label))) +
    bytesToHex(blake3(encoder.encode(`${label}:2`)))
  );
}

interface ChildFixture {
  child: string;
  value: bigint;
}

function board(
  name: string,
  parent: string | null,
  children: Array<ChildFixture | null> = [],
): BoardSnapshot {
  const state: StateV3 = emptyState();
  state.parent.userId = parent === null ? null : owner(parent);
  state.payments = emptyPayments();
  children.forEach((child, index) => {
    if (child === null) return;
    const entry: Entry = {
      value: child.value,
      contact: owner(child.child),
      unit: null,
      note: null,
    };
    state.slots[index] = {
      seq: 1,
      entry,
      sig: sig(`${name}:${index}:1`),
    };
  });
  return {
    ownerId: owner(name),
    state,
    contacts: [],
    codeHash: "hash",
    legacy: false,
  };
}

function fakeSig(label: string): string {
  return sig(label);
}

function depsFor(
  boards: Map<string, BoardSnapshot>,
  target: BoardSnapshot,
): PaymentDeps {
  return {
    readBoard: async (ownerId) => boards.get(ownerId) ?? null,
    savePayment: async (entry, slots: PaymentSlotWrite[]) => {
      const previousEntry = target.state.payments.entry;
      const settled = [...target.state.payments.settled];
      if (previousEntry !== null && (entry === null || previousEntry.id !== entry.id)) {
        if (!settled.includes(previousEntry.id)) settled.push(previousEntry.id);
        if (settled.length > 8) settled.splice(0, settled.length - 8);
      }
      if (entry === null) {
        target.state.payments = {
          seq: target.state.payments.seq + 1,
          settled,
          entry: null,
          sig: fakeSig(`payments:${target.ownerId}:${target.state.payments.seq + 1}`),
        };
        return null;
      }
      const paymentSeq = target.state.payments.seq + 1;
      const legs = [...entry.legs];
      for (const write of slots) {
        const seq = target.state.slots[write.index].seq + 1;
        const slotSig = fakeSig(
          `slot:${target.ownerId}:${write.index}:${seq}:${entry.id}`,
        );
        target.state.slots[write.index] = {
          seq,
          entry: write.entry,
          sig: slotSig,
        };
        if (entry.legs.length === 0) {
          legs.push({
            slot: write.index,
            seq,
            postValue: write.entry.value,
            sig: slotSig,
          });
        }
      }
      const signed = { ...entry, legs };
      target.state.payments = {
        seq: paymentSeq,
        settled,
        entry: signed,
        sig: fakeSig(`payments:${target.ownerId}:${paymentSeq}:${entry.id}`),
      };
      return signed;
    },
  };
}

function expectPlan(result: PaymentPlan | { ok: false }): PaymentPlan {
  if ("ok" in result) {
    throw new Error(`expected a payment plan: ${JSON.stringify(result)}`);
  }
  return result;
}

function tree(): Map<string, BoardSnapshot> {
  // root
  // ├─ 1: source (value 1000)
  // └─ 3: destination (value 500)
  const root = board("r", null, [
    null,
    { child: "s", value: 1000n },
    null,
    { child: "d", value: 500n },
  ]);
  const source = board("s", "r");
  const destination = board("d", "r");
  const boards = new Map<string, BoardSnapshot>([
    [owner("r"), root],
    [owner("s"), source],
    [owner("d"), destination],
  ]);
  return boards;
}

describe("payment planning", () => {
  it("resolves both addresses and the LCA actor", async () => {
    const boards = tree();
    const source = boards.get(owner("s"))!;
    const plan = expectPlan(
      await planPayment(
        source,
        "3",
        owner("d"),
        250n,
        depsFor(boards, boards.get(owner("r"))!),
      ),
    );
    expect(plan.route).toMatchObject({
      srcAddr: "1",
      dstAddr: "3",
      lcaAddr: "",
      debitHops: 1,
      creditHops: 1,
      hops: 2,
    });
    expect(plan.actors.map((actor) => actor.ownerId)).toEqual([owner("r")]);
  });

  it("rejects a mismatched destination user id", async () => {
    const boards = tree();
    const source = boards.get(owner("s"))!;
    const result = await planPayment(
      source,
      "3",
      owner("s"),
      250n,
      depsFor(boards, boards.get(owner("r"))!),
    );
    expect(result).toMatchObject({ ok: false, problem: "address-mismatch" });
  });

  it("rejects an upward leg that would go negative", async () => {
    const boards = tree();
    const source = boards.get(owner("s"))!;
    const result = await planPayment(
      source,
      "3",
      owner("d"),
      1001n,
      depsFor(boards, boards.get(owner("r"))!),
    );
    expect(result).toMatchObject({ ok: false, problem: "negative" });
  });
});

describe("forward payment", () => {
  it("finds the intent in the inbox and applies the LCA pair", async () => {
    const boards = tree();
    const source = boards.get(owner("s"))!;
    const root = boards.get(owner("r"))!;
    const destination = boards.get(owner("d"))!;

    const plan = expectPlan(
      await planPayment(source, "3", owner("d"), 250n, depsFor(boards, root)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = {
      seq: 1,
      settled: [],
      entry: intent,
      sig: fakeSig("source:intent"),
    };

    const incoming = await findIncoming(root, depsFor(boards, root));
    expect(incoming).toHaveLength(1);
    expect(incoming[0].from.ownerId).toBe(owner("s"));
    expect(incoming[0].entry.id).toBe(intent.id);

    // While the source's copy is still offered and no later record exists, a
    // second payment is refused as busy.
    expect(
      await planPayment(source, "3", owner("d"), 100n, depsFor(boards, root)),
    ).toMatchObject({ ok: false, problem: "busy" });

    const signed = await advancePayment(
      root,
      source,
      incoming[0].entry,
      depsFor(boards, root),
    );
    expect(signed.phase).toBe("terminal");
    expect(signed.status).toBe("complete");
    expect(signed.cursor).toBe(2);
    expect(signed.next).toBe("0".repeat(64));
    expect(signed.legs).toHaveLength(2);

    expect(root.state.slots[1].entry?.value).toBe(750n);
    expect(root.state.slots[3].entry?.value).toBe(750n);
    // The destination reads the credit from its parent's slot.
    expect(destination.state.parent.userId).toBe(root.ownerId);
    // The stale source copy must not offer the completed intent again.
    expect(await findIncoming(root, depsFor(boards, root))).toEqual([]);
    // A settled source can start its next payment without an explicit close.
    expect(
      await planPayment(source, "3", owner("d"), 100n, depsFor(boards, root)),
    ).not.toMatchObject({ ok: false, problem: "busy" });
  });

  it("aborts a negative leg and lets the source close the reversal", async () => {
    const boards = tree();
    const source = boards.get(owner("s"))!;
    const root = boards.get(owner("r"))!;
    const plan = expectPlan(
      await planPayment(source, "3", owner("d"), 100n, depsFor(boards, root)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    // Simulate a concurrent spend that landed after planning.
    root.state.slots[1].entry = { ...root.state.slots[1].entry!, value: 50n };

    const aborted = await advancePayment(
      root,
      source,
      intent,
      depsFor(boards, root),
    );
    expect(aborted.phase).toBe("reverse");
    expect(aborted.status).toBe("aborted");
    expect(aborted.fail).toBe("negative");
    expect(aborted.cursor).toBe(0);
    expect(aborted.next).toBe(owner("s"));
    expect(root.state.slots[1].entry?.value).toBe(50n);
    expect(root.state.slots[3].entry?.value).toBe(500n);

    const terminal = await advancePayment(
      source,
      root,
      aborted,
      depsFor(boards, source),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("reversed");
  });
});

describe("multi-level route and reversal", () => {
  it("walks two upward legs then the LCA pair", async () => {
    // root --1--> a --2--> b --0--> source
    // root --1--> a --3--> destination (one credit)
    const root = board("r", null, [null, { child: "a", value: 9999n }]);
    const a = board("a", "r", [null, null, { child: "b", value: 1000n }, { child: "d", value: 500n }]);
    const b = board("b", "a", [{ child: "s", value: 400n }]);
    const source = board("s", "b");
    const destination = board("d", "a");
    const boards = new Map<string, BoardSnapshot>(
      [root, a, b, source, destination].map((item) => [item.ownerId, item]),
    );

    const plan = expectPlan(
      await planPayment(source, "13", owner("d"), 100n, depsFor(boards, b)),
    );
    expect(plan.route).toMatchObject({
      srcAddr: "120",
      dstAddr: "13",
      lcaAddr: "1",
      debitHops: 2,
      creditHops: 1,
      hops: 3,
    });
    expect(plan.actors.map((actor) => actor.ownerId)).toEqual([
      owner("b"),
      owner("a"),
    ]);

    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const bIncoming = await findIncoming(b, depsFor(boards, b));
    expect(bIncoming[0].entry.id).toBe(intent.id);
    const afterB = await advancePayment(b, source, bIncoming[0].entry, depsFor(boards, b));
    expect(afterB.cursor).toBe(1);
    expect(b.state.slots[0].entry?.value).toBe(300n);

    const aIncoming = await findIncoming(a, depsFor(boards, a));
    expect(aIncoming[0].entry.id).toBe(intent.id);
    const afterA = await advancePayment(a, b, aIncoming[0].entry, depsFor(boards, a));
    expect(afterA.phase).toBe("terminal");
    expect(afterA.status).toBe("complete");
    expect(afterA.cursor).toBe(3);
    expect(a.state.slots[2].entry?.value).toBe(900n);
    expect(a.state.slots[3].entry?.value).toBe(600n);

    // The intermediate debit actor can read the finished chain and is no
    // longer wedged as "in progress".
    const bProgress = await paymentProgress(b, afterB, depsFor(boards, b));
    expect(bProgress.phase).toBe("terminal");
    expect(bProgress.status).toBe("complete");

    // A second payment through the same intermediate board is allowed once the
    // previous chain is terminal; the settled list prevents replay of the old
    // source copy.
    const plan2 = expectPlan(
      await planPayment(source, "13", owner("d"), 50n, depsFor(boards, b)),
    );
    const intent2 = createPaymentIntent(plan2, 2);
    await depsFor(boards, source).savePayment(intent2, []);
    const bIncoming2 = await findIncoming(b, depsFor(boards, b));
    expect(bIncoming2).toHaveLength(1);
    expect(bIncoming2[0].entry.id).toBe(intent2.id);
    const afterB2 = await advancePayment(b, source, intent2, depsFor(boards, b));
    expect(afterB2.cursor).toBe(1);
    expect(b.state.slots[0].entry?.value).toBe(250n);
    expect(b.state.payments.settled).toContain(intent.id);
  });

  it("reverses an applied upward leg when the LCA cannot debit", async () => {
    const root = board("r", null, [null, { child: "a", value: 9999n }]);
    const a = board("a", "r", [null, null, { child: "b", value: 1000n }, { child: "d", value: 500n }]);
    const b = board("b", "a", [{ child: "s", value: 400n }]);
    const source = board("s", "b");
    const destination = board("d", "a");
    const boards = new Map<string, BoardSnapshot>(
      [root, a, b, source, destination].map((item) => [item.ownerId, item]),
    );

    const plan = expectPlan(
      await planPayment(source, "13", owner("d"), 100n, depsFor(boards, b)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const afterB = await advancePayment(
      b,
      source,
      intent,
      depsFor(boards, b),
    );
    expect(b.state.slots[0].entry?.value).toBe(300n);

    // The LCA's debit edge was spent after planning.
    a.state.slots[2].entry = { ...a.state.slots[2].entry!, value: 50n };
    const aborted = await advancePayment(a, b, afterB, depsFor(boards, a));
    expect(aborted.status).toBe("aborted");
    expect(aborted.fail).toBe("negative");
    expect(aborted.cursor).toBe(1);
    expect(aborted.next).toBe(owner("b"));
    const reverseInbox = await findIncoming(b, depsFor(boards, b));
    expect(reverseInbox).toHaveLength(1);
    expect(reverseInbox[0].entry.phase).toBe("reverse");

    const reversed = await advancePayment(
      b,
      a,
      aborted,
      depsFor(boards, b),
    );
    expect(reversed.phase).toBe("reverse");
    expect(reversed.status).toBe("reversing");
    expect(reversed.cursor).toBe(0);
    expect(reversed.next).toBe(owner("s"));
    expect(b.state.slots[0].entry?.value).toBe(400n);

    const terminal = await advancePayment(
      source,
      b,
      reversed,
      depsFor(boards, source),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("reversed");
  });
});

describe("credit reversal and progress", () => {
  it("reverses the LCA pair when the destination link is broken", async () => {
    // root --1--> lca
    // lca --1--> source
    // lca --3--> middle --0--> destination
    const root = board("r", null, [null, { child: "lca", value: 9999n }]);
    const lca = board("lca", "r", [
      null,
      { child: "s", value: 1000n },
      null,
      { child: "c", value: 500n },
    ]);
    const source = board("s", "lca");
    const middle = board("c", "lca", [{ child: "d", value: 400n }]);
    const destination = board("d", "c");
    const boards = new Map<string, BoardSnapshot>(
      [root, lca, source, middle, destination].map((item) => [item.ownerId, item]),
    );

    const plan = expectPlan(
      await planPayment(
        source,
        "130",
        owner("d"),
        50n,
        depsFor(boards, lca),
      ),
    );
    expect(plan.route).toMatchObject({
      srcAddr: "11",
      dstAddr: "130",
      lcaAddr: "1",
      debitHops: 1,
      creditHops: 2,
      hops: 3,
    });
    expect(plan.actors.map((actor) => actor.ownerId)).toEqual([
      owner("lca"),
      owner("c"),
    ]);

    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const afterLca = await advancePayment(lca, source, intent, depsFor(boards, lca));
    expect(afterLca.cursor).toBe(2);
    expect(lca.state.slots[1].entry?.value).toBe(950n);
    expect(lca.state.slots[3].entry?.value).toBe(550n);

    // The destination slot was re-pointed after the LCA credited the middle.
    middle.state.slots[0].entry = {
      ...middle.state.slots[0].entry!,
      contact: owner("other"),
    };
    const aborted = await advancePayment(middle, lca, afterLca, depsFor(boards, middle));
    expect(aborted.status).toBe("aborted");
    expect(aborted.fail).toBe("address-mismatch");
    expect(aborted.cursor).toBe(2);
    expect(aborted.next).toBe(owner("lca"));

    const reversed = await advancePayment(lca, middle, aborted, depsFor(boards, lca));
    expect(reversed.phase).toBe("reverse");
    expect(reversed.cursor).toBe(0);
    expect(reversed.next).toBe(owner("s"));
    expect(lca.state.slots[1].entry?.value).toBe(1000n);
    expect(lca.state.slots[3].entry?.value).toBe(500n);
    expect(middle.state.slots[0].entry?.value).toBe(400n);

    const terminal = await advancePayment(source, lca, reversed, depsFor(boards, source));
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("reversed");
  });

  it("skips a reversal when a later write superseded the leg", async () => {
    const root = board("r", null, [null, { child: "a", value: 9999n }]);
    const a = board("a", "r", [null, null, { child: "b", value: 1000n }, { child: "d", value: 500n }]);
    const b = board("b", "a", [{ child: "s", value: 400n }]);
    const source = board("s", "b");
    const destination = board("d", "a");
    const boards = new Map<string, BoardSnapshot>(
      [root, a, b, source, destination].map((item) => [item.ownerId, item]),
    );

    const plan = expectPlan(
      await planPayment(source, "13", owner("d"), 100n, depsFor(boards, b)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const afterB = await advancePayment(b, source, intent, depsFor(boards, b));

    // A later signed write replaces the leg before the reverse arrives.
    b.state.slots[0] = {
      seq: b.state.slots[0].seq + 1,
      entry: { ...b.state.slots[0].entry!, value: 300n },
      sig: fakeSig("later-write"),
    };
    a.state.slots[2].entry = { ...a.state.slots[2].entry!, value: 50n };
    const aborted = await advancePayment(a, b, afterB, depsFor(boards, a));
    const superseded = await advancePayment(b, a, aborted, depsFor(boards, b));
    expect(superseded.phase).toBe("terminal");
    expect(superseded.status).toBe("superseded");
    expect(superseded.fail).toBe("superseded");
    expect(b.state.slots[0].entry?.value).toBe(300n);
  });

  it("follows the signed record chain for source progress", async () => {
    const root = board("r", null, [null, { child: "a", value: 9999n }]);
    const a = board("a", "r", [null, null, { child: "b", value: 1000n }, { child: "d", value: 500n }]);
    const b = board("b", "a", [{ child: "s", value: 400n }]);
    const source = board("s", "b");
    const destination = board("d", "a");
    const boards = new Map<string, BoardSnapshot>(
      [root, a, b, source, destination].map((item) => [item.ownerId, item]),
    );

    const plan = expectPlan(
      await planPayment(source, "13", owner("d"), 100n, depsFor(boards, b)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const afterB = await advancePayment(b, source, intent, depsFor(boards, b));
    const afterA = await advancePayment(a, b, afterB, depsFor(boards, a));

    const progress = await paymentProgress(
      source,
      intent,
      depsFor(boards, source),
    );
    expect(progress.id).toBe(afterA.id);
    expect(progress.status).toBe("complete");
  });
});

describe("protocol authorization", () => {
  it("rejects a source address that points at a different slot", async () => {
    const root = board("r", null, [
      null,
      { child: "s", value: 1000n },
      null,
      { child: "rich", value: 1000n },
    ]);
    const source = board("s", "r");
    const rich = board("rich", "r");
    const boards = new Map<string, BoardSnapshot>(
      [root, source, rich].map((item) => [item.ownerId, item]),
    );
    const forged: PaymentEntry = {
      id: paymentId(owner("s"), 1, owner("s"), 100n),
      src: owner("s"),
      dst: owner("s"),
      amount: 100n,
      // Claims the rich sibling's slot while src says the attacker.
      srcAddr: "3",
      dstAddr: "1",
      cursor: 0,
      phase: "forward",
      status: "offered",
      next: root.ownerId,
      fail: null,
      legs: [],
    };
    source.state.payments = { seq: 1, settled: [], entry: forged, sig: fakeSig("forged") };
    await expect(
      advancePayment(root, source, forged, depsFor(boards, root)),
    ).rejects.toThrow(/source id does not match/);
  });


  it("ignores an intent whose id is already in settled", async () => {
    const boards = tree();
    const source = boards.get(owner("s"))!;
    const root = boards.get(owner("r"))!;
    const plan = expectPlan(
      await planPayment(source, "3", owner("d"), 100n, depsFor(boards, root)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    root.state.payments = {
      seq: 2,
      settled: [intent.id],
      entry: null,
      sig: fakeSig("settled"),
    };
    expect(await findIncoming(root, depsFor(boards, root))).toEqual([]);
  });

  it("rejects a reverse copy with a different amount", async () => {
    const root = board("r", null, [null, { child: "a", value: 9999n }]);
    const a = board("a", "r", [null, null, { child: "b", value: 1000n }, { child: "d", value: 500n }]);
    const b = board("b", "a", [{ child: "s", value: 400n }]);
    const source = board("s", "b");
    const destination = board("d", "a");
    const boards = new Map<string, BoardSnapshot>(
      [root, a, b, source, destination].map((item) => [item.ownerId, item]),
    );
    const plan = expectPlan(
      await planPayment(source, "13", owner("d"), 100n, depsFor(boards, b)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const afterB = await advancePayment(b, source, intent, depsFor(boards, b));
    a.state.slots[2].entry = { ...a.state.slots[2].entry!, value: 50n };
    const aborted = await advancePayment(a, b, afterB, depsFor(boards, a));
    const forged = { ...aborted, amount: 1000n };
    await expect(
      advancePayment(b, a, forged, depsFor(boards, b)),
    ).rejects.toThrow(/does not match this zone's signed record/);
  });
});

  it("rejects a reverse request from the wrong neighbour", async () => {
    const root = board("r", null, [null, { child: "a", value: 9999n }]);
    const a = board("a", "r", [null, null, { child: "b", value: 1000n }, { child: "d", value: 500n }]);
    const b = board("b", "a", [{ child: "s", value: 400n }]);
    const source = board("s", "b");
    const destination = board("d", "a");
    const boards = new Map<string, BoardSnapshot>(
      [root, a, b, source, destination].map((item) => [item.ownerId, item]),
    );
    const plan = expectPlan(
      await planPayment(source, "13", owner("d"), 100n, depsFor(boards, b)),
    );
    const intent = createPaymentIntent(plan, 1);
    source.state.payments = { seq: 1, settled: [], entry: intent, sig: fakeSig("intent") };
    const afterB = await advancePayment(b, source, intent, depsFor(boards, b));
    a.state.slots[2].entry = { ...a.state.slots[2].entry!, value: 50n };
    const aborted = await advancePayment(a, b, afterB, depsFor(boards, a));
    await expect(
      advancePayment(b, source, aborted, depsFor(boards, b)),
    ).rejects.toThrow(/reverse request did not come/);
  });

  it("does not let a stale reverse clobber a newer source offer", async () => {
    const root = board("r", null, [null, { child: "s", value: 1000n }]);
    const source = board("s", "r");
    const boards = new Map<string, BoardSnapshot>(
      [root, source].map((item) => [item.ownerId, item]),
    );
    const staleId = paymentId(owner("s"), 1, owner("d"), 100n);
    const stale: PaymentEntry = {
      id: staleId,
      src: owner("s"),
      dst: owner("d"),
      amount: 100n,
      srcAddr: "1",
      dstAddr: "2",
      cursor: 0,
      phase: "reverse",
      status: "aborted",
      next: source.ownerId,
      fail: "negative",
      legs: [],
    };
    root.state.payments = { seq: 2, settled: [], entry: stale, sig: fakeSig("stale") };
    const newer: PaymentEntry = {
      id: paymentId(owner("s"), 3, owner("d"), 200n),
      src: owner("s"),
      dst: owner("d"),
      amount: 200n,
      srcAddr: "1",
      dstAddr: "2",
      cursor: 0,
      phase: "forward",
      status: "offered",
      next: root.ownerId,
      fail: null,
      legs: [],
    };
    source.state.payments = { seq: 3, settled: [], entry: newer, sig: fakeSig("new-offer") };
    await expect(
      advancePayment(source, root, stale, depsFor(boards, source)),
    ).rejects.toThrow(/does not match this zone's signed record/);
  });

describe("address book and receive-link helpers", () => {
  const contact = {
    label: "Alice",
    userId: owner("a"),
    address: "03",
  };

  it("shows the stored octal address or its absence", () => {
    expect(contactAddressLabel("03")).toBe("03");
    expect(contactAddressLabel(null)).toBe("not set");
    expect(recipientAddressLine("03")).toBe("Address 03");
    expect(recipientAddressLine(null)).toBe(
      "No address yet. Ask them for a receive link.",
    );
  });

  it("accepts optional octal addresses and rejects the root/other digits", () => {
    expect(contactAddressProblem("")).toBeNull();
    expect(contactAddressProblem("03")).toBeNull();
    expect(contactAddressProblem("0".repeat(32))).toBeNull();
    expect(contactAddressProblem("0".repeat(33))).toContain("32");
    expect(contactAddressProblem("8")).toContain("0–7");
    expect(contactAddressProblem("12a")).toContain("0–7");
  });

  it("renames a contact without touching its stored address", () => {
    expect(contactUpdatePatch(contact, { label: "Alicia", address: "03" }))
      .toEqual({ label: "Alicia" });
    expect(contactUpdatePatch(contact, { label: "Alice", address: "4" }))
      .toEqual({ address: "4" });
    expect(contactUpdatePatch(contact, { label: "Alice", address: "03" }))
      .toEqual({});
  });

  it("parses a valid link and ignores a bad address", () => {
    const parsed = parseReceiveInvite(
      `?pay=${owner("a")}&name=Alice&addr=03`,
    );
    expect(parsed).toEqual({
      kind: "link",
      invite: { userId: owner("a"), name: "Alice", address: "03" },
    });
    expect(
      parseReceiveInvite(`?pay=${owner("a")}&addr=8`),
    ).toEqual({
      kind: "link",
      invite: { userId: owner("a"), name: null, address: null },
    });
    expect(parseReceiveInvite("?view=advanced")).toEqual({ kind: "none" });
  });

  it("rejects missing and invalid pay params as incomplete", () => {
    expect(parseReceiveInvite("?name=Alice&addr=03")).toEqual({
      kind: "incomplete",
    });
    expect(parseReceiveInvite("?pay=not-a-key&name=Alice")).toEqual({
      kind: "incomplete",
    });
    expect(parseReceiveInvite("?pay=")).toEqual({ kind: "incomplete" });
  });

  it("separates own-id, existing-contact and fresh invites", () => {
    const ownLink = `?pay=${owner("a")}`;
    expect(resolveReceiveInvite(ownLink, owner("a"), [])).toEqual({
      kind: "own",
    });
    expect(
      resolveReceiveInvite(`?pay=${contact.userId}`, owner("b"), [contact]),
    ).toEqual({ kind: "existing", contact });
    expect(
      resolveReceiveInvite(`?pay=${contact.userId}`, owner("b"), []),
    ).toEqual({
      kind: "invite",
      invite: { userId: contact.userId, name: null, address: null },
    });
  });
});

/**
 * A fixture tree with a root that has both a child and a grandchild, and a
 * removable upward link:
 *
 *   root  --1--> a (value 1000)
 *         --3--> c (value 500) --1--> d (value 400)
 */
function wideTree(): Map<string, BoardSnapshot> {
  const root = board("r", null, [
    null,
    { child: "a", value: 1000n },
    null,
    { child: "c", value: 500n },
  ]);
  const a = board("a", "r");
  const c = board("c", "r", [null, { child: "d", value: 400n }]);
  const d = board("d", "c");
  return new Map<string, BoardSnapshot>(
    [root, a, c, d].map((item) => [item.ownerId, item]),
  );
}

function zeroOwner(): string {
  return "0".repeat(64);
}

describe("LCA-endpoint routes", () => {
  it("root to child is one terminal credit (implicit issue)", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const child = boards.get(owner("c"))!;

    const plan = expectPlan(
      await planPayment(root, "3", owner("c"), 100n, depsFor(boards, root)),
    );
    expect(plan.route).toMatchObject({
      srcAddr: "",
      dstAddr: "3",
      lcaAddr: "",
      debitHops: 0,
      creditHops: 1,
      hops: 1,
    });
    expect(plan.actors).toEqual([]);
    expect(plan.sourceStep).not.toBeNull();
    expect(plan.sourceStep!.step).toMatchObject({
      role: "source",
      ownAddress: "",
      slots: [{ slot: 3, direction: "credit" }],
      nextCursor: 1,
      nextAddress: null,
    });

    const intent = createPaymentIntent(plan, 1);
    expect(intent.cursor).toBe(1);
    expect(intent.phase).toBe("terminal");
    expect(intent.status).toBe("complete");
    expect(intent.next).toBe(zeroOwner());
    const saved = await depsFor(boards, root).savePayment(
      intent,
      plan.sourceStep!.slots,
    );
    expect(saved?.legs).toHaveLength(1);
    expect(root.state.slots[3].entry?.value).toBe(600n);
    expect(root.state.payments.entry?.status).toBe("complete");
    expect(child.state.parent.userId).toBe(root.ownerId);
  });

  it("root to grandchild carries the leg on the source record, then the child terminates", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const c = boards.get(owner("c"))!;

    const plan = expectPlan(
      await planPayment(root, "31", owner("d"), 100n, depsFor(boards, root)),
    );
    expect(plan.route).toMatchObject({
      debitHops: 0,
      creditHops: 2,
      hops: 2,
    });
    expect(plan.actors.map((actor) => actor.ownerId)).toEqual([owner("c")]);

    const intent = createPaymentIntent(plan, 1);
    expect(intent.cursor).toBe(1);
    expect(intent.status).toBe("acted");
    expect(intent.next).toBe(owner("c"));
    const saved = await depsFor(boards, root).savePayment(
      intent,
      plan.sourceStep!.slots,
    );
    expect(saved?.legs).toHaveLength(1);
    expect(root.state.payments.entry?.cursor).toBe(1);
    expect(root.state.payments.entry?.legs).toHaveLength(1);

    const incoming = await findIncoming(c, depsFor(boards, c));
    expect(incoming).toHaveLength(1);
    expect(incoming[0].entry.id).toBe(intent.id);

    const terminal = await advancePayment(
      c,
      root,
      incoming[0].entry,
      depsFor(boards, c),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("complete");
    expect(terminal.cursor).toBe(2);
    expect(terminal.next).toBe(zeroOwner());
    expect(root.state.slots[3].entry?.value).toBe(600n);
    expect(c.state.slots[1].entry?.value).toBe(500n);
  });

  it("child to parent is one terminal debit at the LCA (implicit burn)", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const a = boards.get(owner("a"))!;

    const plan = expectPlan(
      await planPayment(a, "", owner("r"), 100n, depsFor(boards, a)),
    );
    expect(plan.route).toMatchObject({
      srcAddr: "1",
      dstAddr: "",
      lcaAddr: "",
      debitHops: 1,
      creditHops: 0,
      hops: 1,
    });
    expect(plan.sourceStep).toBeNull();
    expect(plan.actors.map((actor) => actor.ownerId)).toEqual([owner("r")]);
    expect(plan.actors[0].step).toMatchObject({
      role: "lca",
      slots: [{ slot: 1, direction: "debit" }],
      nextCursor: 1,
      nextAddress: null,
    });

    const intent = createPaymentIntent(plan, 1);
    expect(intent.cursor).toBe(0);
    expect(intent.status).toBe("offered");
    expect(intent.next).toBe(owner("r"));
    await depsFor(boards, a).savePayment(intent, []);

    const terminal = await advancePayment(
      root,
      a,
      intent,
      depsFor(boards, root),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("complete");
    expect(terminal.next).toBe(zeroOwner());
    expect(root.state.slots[1].entry?.value).toBe(900n);
    expect(a.state.parent.userId).toBe(root.ownerId);
  });

  it("grandchild to grandparent debits twice and terminates at the LCA", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const c = boards.get(owner("c"))!;
    const d = boards.get(owner("d"))!;

    const plan = expectPlan(
      await planPayment(d, "", owner("r"), 100n, depsFor(boards, d)),
    );
    expect(plan.route).toMatchObject({
      srcAddr: "31",
      dstAddr: "",
      debitHops: 2,
      creditHops: 0,
      hops: 2,
    });
    expect(plan.actors.map((actor) => actor.ownerId)).toEqual([
      owner("c"),
      owner("r"),
    ]);

    const intent = createPaymentIntent(plan, 1);
    await depsFor(boards, d).savePayment(intent, []);
    const afterC = await advancePayment(c, d, intent, depsFor(boards, c));
    expect(afterC.cursor).toBe(1);
    expect(afterC.status).toBe("acted");
    expect(afterC.next).toBe(owner("r"));
    expect(c.state.slots[1].entry?.value).toBe(300n);

    const terminal = await advancePayment(
      root,
      c,
      afterC,
      depsFor(boards, root),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("complete");
    expect(terminal.cursor).toBe(2);
    expect(root.state.slots[3].entry?.value).toBe(400n);
  });

  it("a dD = 0 route with insufficient value fails as negative before signing", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const a = boards.get(owner("a"))!;
    const result = await planPayment(a, "", owner("r"), 1001n, depsFor(boards, a));
    expect(result).toMatchObject({ ok: false, problem: "negative" });
    expect(root.state.slots[1].entry?.value).toBe(1000n);
  });

  it("a dS = 0 child abort lets the source reverse and terminate with the slot restored", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const c = boards.get(owner("c"))!;

    const plan = expectPlan(
      await planPayment(root, "31", owner("d"), 100n, depsFor(boards, root)),
    );
    const intent = createPaymentIntent(plan, 1);
    const sourceEntry = await depsFor(boards, root).savePayment(
      intent,
      plan.sourceStep!.slots,
    );
    expect(root.state.slots[3].entry?.value).toBe(600n);

    // The first destination child points its final slot somewhere else.
    c.state.slots[1].entry = { ...c.state.slots[1].entry!, contact: owner("other") };
    const aborted = await advancePayment(c, root, sourceEntry!, depsFor(boards, c));
    expect(aborted.phase).toBe("reverse");
    expect(aborted.status).toBe("aborted");
    expect(aborted.cursor).toBe(1);
    expect(aborted.next).toBe(owner("r"));

    const terminal = await advancePayment(
      root,
      c,
      aborted,
      depsFor(boards, root),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("reversed");
    expect(terminal.next).toBe(zeroOwner());
    expect(root.state.slots[3].entry?.value).toBe(500n);
    expect(root.state.payments.entry?.status).toBe("reversed");
  });

  it("a payer slot rewrite reports superseded, not blocked", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const c = boards.get(owner("c"))!;

    const plan = expectPlan(
      await planPayment(root, "31", owner("d"), 100n, depsFor(boards, root)),
    );
    const intent = createPaymentIntent(plan, 1);
    const sourceEntry = await depsFor(boards, root).savePayment(
      intent,
      plan.sourceStep!.slots,
    );

    c.state.slots[1].entry = { ...c.state.slots[1].entry!, contact: owner("other") };
    const aborted = await advancePayment(c, root, sourceEntry!, depsFor(boards, c));

    // The payer rewrote its own slot after issuing.
    root.state.slots[3] = {
      seq: root.state.slots[3].seq + 1,
      entry: { ...root.state.slots[3].entry!, value: 777n },
      sig: fakeSig("later-write"),
    };
    const terminal = await advancePayment(
      root,
      c,
      aborted,
      depsFor(boards, root),
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.status).toBe("superseded");
    expect(terminal.fail).toBe("superseded");
    expect(root.state.slots[3].entry?.value).toBe(777n);
  });

  it("a stalled dS = 0 source can withdraw, restoring the issued credit", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;

    const plan = expectPlan(
      await planPayment(root, "31", owner("d"), 100n, depsFor(boards, root)),
    );
    const intent = createPaymentIntent(plan, 1);
    const sourceEntry = await depsFor(boards, root).savePayment(
      intent,
      plan.sourceStep!.slots,
    );
    expect(root.state.slots[3].entry?.value).toBe(600n);

    const terminal = await withdrawPayment(
      root,
      sourceEntry!,
      depsFor(boards, root),
    );
    expect(terminal?.phase).toBe("terminal");
    expect(terminal?.status).toBe("reversed");
    expect(root.state.slots[3].entry?.value).toBe(500n);
    expect(root.state.payments.entry?.status).toBe("reversed");
  });

  it("rejects a reverse at a completed dD = 0 LCA without touching the slot", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const a = boards.get(owner("a"))!;

    const plan = expectPlan(
      await planPayment(a, "", owner("r"), 100n, depsFor(boards, a)),
    );
    const intent = createPaymentIntent(plan, 1);
    await depsFor(boards, a).savePayment(intent, []);
    const terminal = await advancePayment(root, a, intent, depsFor(boards, root));
    expect(terminal.status).toBe("complete");
    expect(root.state.slots[1].entry?.value).toBe(900n);

    const reverseRequest: PaymentEntry = {
      ...terminal,
      phase: "reverse",
      status: "reversing",
      cursor: 1,
      next: root.ownerId,
      fail: null,
    };
    await expect(
      advancePayment(root, a, reverseRequest, depsFor(boards, root)),
    ).rejects.toThrow();
    expect(root.state.slots[1].entry?.value).toBe(900n);
    expect(root.state.payments.entry?.status).toBe("complete");
  });

  it("rejects an address that only exists under another root", async () => {
    // Both chains are resolved from the source's root, so an address in
    // another tree has no slot path and cannot be routed. The `different-roots`
    // check remains as defence for a diverged prefix.
    const rootR = board("r", null, [null, { child: "s", value: 1000n }]);
    const source = board("s", "r");
    const rootQ = board("q", null, [
      null,
      null,
      null,
      { child: "d", value: 500n },
    ]);
    const destination = board("d", "q");
    const boards = new Map<string, BoardSnapshot>(
      [rootR, source, rootQ, destination].map((item) => [item.ownerId, item]),
    );

    const result = await planPayment(
      source,
      "3",
      destination.ownerId,
      100n,
      depsFor(boards, rootR),
    );
    expect(result).toMatchObject({ ok: false, problem: "no-destination" });
  });

  it("plans an empty (root) LCA address", async () => {
    const boards = wideTree();
    const root = boards.get(owner("r"))!;
    const plan = expectPlan(
      await planPayment(root, "3", owner("c"), 100n, depsFor(boards, root)),
    );
    expect(plan.route.lcaAddr).toBe("");
    expect(plan.sourceStep!.step.ownAddress).toBe("");
    expect(plan.destination.ownerId).toBe(owner("c"));
  });
});
