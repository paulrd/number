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
  type PaymentDeps,
  type PaymentEntry,
  type PaymentPlan,
  type PaymentSlotWrite,
} from "./payments";
import { emptyPayments, emptyState, type Entry, type StateV3 } from "./state";
import { bytesToHex } from "./util";

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
    ).rejects.toThrow(/does not match this board's signed record/);
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
    ).rejects.toThrow(/does not match this board's signed record/);
  });
