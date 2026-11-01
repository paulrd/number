import { describe, expect, it } from "vitest";
import {
  actorStep,
  commonPrefixLength,
  isOctalAddress,
  isStuckForeignRecord,
  paymentId,
  planRoute,
  type ActorStep,
  type PaymentRoute,
} from "./payments";

const SRC = "1111111111111111111111111111111111111111111111111111111111111111";
const DST = "2222222222222222222222222222222222222222222222222222222222222222";

function routeOrThrow(src: string, dst: string): PaymentRoute {
  const route = planRoute(src, dst);
  if ("error" in route) {
    throw new Error(`expected a route for ${src} -> ${dst}: ${route.error}`);
  }
  return route;
}

function stepOrThrow(
  route: PaymentRoute,
  cursor: number,
  ownAddress?: string,
): ActorStep {
  const step = actorStep(route, cursor, ownAddress);
  if ("error" in step) {
    throw new Error(
      `expected an actor at ${cursor} for ${route.srcAddr} -> ${route.dstAddr}: ${step.error}`,
    );
  }
  return step;
}

describe("octal address helpers", () => {
  it("accepts only 0-7 digits up to 32 characters", () => {
    expect(isOctalAddress("")).toBe(true);
    expect(isOctalAddress("01234567")).toBe(true);
    expect(isOctalAddress("8")).toBe(false);
    expect(isOctalAddress("12a")).toBe(false);
    expect(isOctalAddress("0".repeat(33))).toBe(false);
  });

  it("finds the common prefix", () => {
    expect(commonPrefixLength("125", "134")).toBe(1);
    expect(commonPrefixLength("", "12")).toBe(0);
    expect(commonPrefixLength("12", "12")).toBe(2);
  });
});

describe("planRoute", () => {
  it("plans a sibling-style route through the root", () => {
    expect(planRoute("52", "31")).toEqual({
      srcAddr: "52",
      dstAddr: "31",
      lcaLength: 0,
      debitHops: 2,
      creditHops: 2,
      hops: 4,
      lcaAddr: "",
    });
  });

  it("plans a route with a non-root LCA", () => {
    expect(planRoute("125", "134")).toMatchObject({
      lcaLength: 1,
      lcaAddr: "1",
      debitHops: 2,
      creditHops: 2,
      hops: 4,
    });
  });

  it("allows either endpoint to be the LCA", () => {
    expect(planRoute("", "1")).toMatchObject({
      lcaLength: 0,
      lcaAddr: "",
      debitHops: 0,
      creditHops: 1,
      hops: 1,
    });
    expect(planRoute("1", "")).toMatchObject({
      lcaLength: 0,
      lcaAddr: "",
      debitHops: 1,
      creditHops: 0,
      hops: 1,
    });
    expect(planRoute("", "31")).toMatchObject({
      debitHops: 0,
      creditHops: 2,
      hops: 2,
    });
    expect(planRoute("31", "")).toMatchObject({
      debitHops: 2,
      creditHops: 0,
      hops: 2,
    });
    expect(planRoute("1", "12")).toMatchObject({
      lcaLength: 1,
      debitHops: 0,
      creditHops: 1,
      hops: 1,
    });
    expect(planRoute("12", "1")).toMatchObject({
      lcaLength: 1,
      debitHops: 1,
      creditHops: 0,
      hops: 1,
    });
  });

  it("rejects only the same address and malformed addresses", () => {
    expect(planRoute("", "")).toEqual({ error: "same-address" });
    expect(planRoute("12", "12")).toEqual({ error: "same-address" });
    expect(planRoute("18", "2")).toEqual({ error: "invalid-address" });
    expect(planRoute("1", "x")).toEqual({ error: "invalid-address" });
  });
});

describe("actorStep", () => {
  const route = routeOrThrow("125", "134");

  it("gives the source no leg and points at its parent", () => {
    expect(actorStep(route, 0, "125")).toEqual({
      role: "source",
      ownAddress: "125",
      slots: [],
      nextCursor: 0,
      nextAddress: "12",
    });
  });

  it("walks the upward leg to the LCA", () => {
    expect(actorStep(route, 0)).toEqual({
      role: "debit",
      ownAddress: "12",
      slots: [{ slot: 5, direction: "debit" }],
      nextCursor: 1,
      nextAddress: "1",
    });
    expect(actorStep(route, 1)).toEqual({
      role: "lca",
      ownAddress: "1",
      slots: [
        { slot: 2, direction: "debit" },
        { slot: 3, direction: "credit" },
      ],
      nextCursor: 3,
      nextAddress: "13",
    });
  });

  it("walks the downward leg to the destination", () => {
    expect(actorStep(route, 3)).toEqual({
      role: "credit",
      ownAddress: "13",
      slots: [{ slot: 4, direction: "credit" }],
      nextCursor: 4,
      nextAddress: null,
    });
    expect(actorStep(route, 4)).toMatchObject({
      role: "terminal",
      nextAddress: null,
    });
  });

  it("rejects a board that is not the expected actor", () => {
    expect(actorStep(route, 0, "99")).toEqual({ error: "not-an-actor" });
  });

  it("rejects cursors the protocol never issues", () => {
    expect(actorStep(route, 2)).toEqual({ error: "invalid-cursor" });
    expect(actorStep(route, 5)).toEqual({ error: "invalid-cursor" });
    expect(actorStep(route, -1)).toEqual({ error: "invalid-cursor" });
  });

  it("handles a one-hop credit side after the LCA", () => {
    const short = routeOrThrow("12", "13");
    expect(actorStep(short, 0)).toEqual({
      role: "lca",
      ownAddress: "1",
      slots: [
        { slot: 2, direction: "debit" },
        { slot: 3, direction: "credit" },
      ],
      nextCursor: 2,
      nextAddress: null,
    });
  });

  it("collapses the source into the LCA for a downward-only route", () => {
    const rootToChild = routeOrThrow("", "3");
    expect(actorStep(rootToChild, 0, "")).toEqual({
      role: "source",
      ownAddress: "",
      slots: [{ slot: 3, direction: "credit" }],
      nextCursor: 1,
      nextAddress: null,
    });

    const rootToGrandchild = routeOrThrow("", "31");
    expect(actorStep(rootToGrandchild, 0, "")).toEqual({
      role: "source",
      ownAddress: "",
      slots: [{ slot: 3, direction: "credit" }],
      nextCursor: 1,
      nextAddress: "3",
    });

    const lcaToChild = routeOrThrow("3", "31");
    expect(actorStep(lcaToChild, 0, "3")).toEqual({
      role: "source",
      ownAddress: "3",
      slots: [{ slot: 1, direction: "credit" }],
      nextCursor: 1,
      nextAddress: null,
    });

    // With `dS = 0` cursor 0 is not a phantom post-LCA cursor.
    expect(actorStep(rootToGrandchild, 0, "3")).toEqual({
      error: "not-an-actor",
    });
  });

  it("makes an upward-only LCA hop debit-only and terminal", () => {
    expect(actorStep(routeOrThrow("3", ""), 0, "")).toEqual({
      role: "lca",
      ownAddress: "",
      slots: [{ slot: 3, direction: "debit" }],
      nextCursor: 1,
      nextAddress: null,
    });
    const deeper = routeOrThrow("31", "");
    expect(actorStep(deeper, 0)).toEqual({
      role: "debit",
      ownAddress: "3",
      slots: [{ slot: 1, direction: "debit" }],
      nextCursor: 1,
      nextAddress: "",
    });
    expect(actorStep(deeper, 1)).toEqual({
      role: "lca",
      ownAddress: "",
      slots: [{ slot: 3, direction: "debit" }],
      nextCursor: 2,
      nextAddress: null,
    });
    // `dst[lcaLength]` is never read for `dD = 0`.
    expect(actorStep(deeper, 1, "3")).toEqual({ error: "not-an-actor" });
  });
});

/**
 * The fixture tree. Every ordered pair is walked at every cursor the protocol
 * issues, including the source step that shares cursor 0 with the first leg.
 */
const FIXTURE_ADDRESSES = ["", "1", "2", "12", "21", "120", "121", "13"];

describe("actorStep table over a fixture tree", () => {
  it("tiles the route with one actor per issued cursor", () => {
    for (const srcAddr of FIXTURE_ADDRESSES) {
      for (const dstAddr of FIXTURE_ADDRESSES) {
        if (srcAddr === dstAddr) continue;
        const route = routeOrThrow(srcAddr, dstAddr);
        const label = `${srcAddr || "root"} -> ${dstAddr || "root"}`;

        // The source acts first. With `dS = 0` that is the collapsed step;
        // with `dS >= 1` it has no leg and points at its parent.
        const source = stepOrThrow(route, 0, srcAddr);
        expect(source.role, label).toBe("source");
        expect(source.ownAddress, label).toBe(srcAddr);
        const ownAddresses = [source.ownAddress];
        const visited = new Set<number>([0]);
        let cursor = 0;
        if (route.debitHops === 0) {
          // The collapsed source step already wrote the first credit.
          expect(source.slots, label).toHaveLength(1);
          expect(source.slots[0].direction, label).toBe("credit");
          expect(
            source.nextCursor === 1 || source.nextCursor === route.hops,
            label,
          ).toBe(true);
          expect(source.nextAddress, label).toBe(
            source.nextCursor === route.hops
              ? null
              : dstAddr.slice(0, route.lcaLength + 1),
          );
          cursor = source.nextCursor;
          if (cursor < route.hops) visited.add(cursor);
        } else {
          expect(source.slots, label).toHaveLength(0);
          expect(source.nextCursor, label).toBe(0);
          expect(source.nextAddress, label).toBe(srcAddr.slice(0, -1));
        }

        // The LCA's second logical hop is a phantom cursor, part of the same
        // delta. It has no actor and is the only cursor that is not visited.
        if (route.debitHops >= 1 && route.debitHops < route.hops) {
          expect(
            actorStep(route, route.debitHops),
            `${label} phantom cursor ${route.debitHops}`,
          ).toEqual({ error: "invalid-cursor" });
          visited.add(route.debitHops);
        }

        // Walk every leg actor.
        let terminalNextAddress: string | null = null;
        let terminalStep: ActorStep | null = null;
        while (cursor < route.hops) {
          const step = stepOrThrow(route, cursor);
          visited.add(cursor);
          // Every delta advances: one hop, or two for the LCA pair, or to N.
          expect(step.nextCursor, `${label} cursor ${cursor}`).toBeGreaterThan(
            cursor,
          );
          expect(
            step.nextCursor === cursor + 1 ||
              step.nextCursor === cursor + 2 ||
              step.nextCursor === route.hops,
            `${label} cursor ${cursor} -> ${step.nextCursor}`,
          ).toBe(true);
          if (step.role === "lca" && step.nextCursor === cursor + 2) {
            expect(route.creditHops, label).toBeGreaterThanOrEqual(1);
          }
          if (step.nextCursor !== route.hops) {
            expect(step.nextAddress, `${label} cursor ${cursor}`).not.toBeNull();
            const next = stepOrThrow(route, step.nextCursor);
            expect(next.ownAddress, `${label} cursor ${cursor}`).toBe(
              step.nextAddress,
            );
          } else {
            expect(step.nextAddress, `${label} cursor ${cursor}`).toBeNull();
          }
          ownAddresses.push(step.ownAddress);
          terminalStep = step;
          terminalNextAddress = step.nextAddress;
          cursor = step.nextCursor;
        }
        expect(cursor, label).toBe(route.hops);
        for (let each = 0; each < route.hops; each += 1) {
          expect(visited.has(each), `${label} skipped cursor ${each}`).toBe(true);
        }
        if (terminalStep === null) {
          // `dS = 0, dD = 1`: the collapsed source step is the whole route.
          expect(route.hops, label).toBe(1);
          expect(source.nextCursor, label).toBe(1);
          expect(source.nextAddress, label).toBeNull();
        } else {
          expect(terminalNextAddress, label).toBeNull();
        }

        // Actor addresses tile the route: source side up to the LCA, then the
        // destination side (the destination is credited, so it never acts).
        const expected: string[] = [];
        if (route.debitHops >= 1) {
          for (let depth = srcAddr.length; depth >= route.lcaLength; depth -= 1) {
            expected.push(srcAddr.slice(0, depth));
          }
        } else {
          expected.push(route.lcaAddr);
        }
        for (let depth = route.lcaLength + 1; depth < dstAddr.length; depth += 1) {
          expected.push(dstAddr.slice(0, depth));
        }
        expect(ownAddresses, label).toEqual(expected);
      }
    }
  });
});

describe("paymentId", () => {
  it("is deterministic, 16 bytes, and amount-sensitive", () => {
    const a = paymentId(SRC, 3, DST, 1250n);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(paymentId(SRC, 3, DST, 1250n)).toBe(a);
    expect(paymentId(SRC, 3, DST, 1251n)).not.toBe(a);
    expect(paymentId(SRC, 4, DST, 1250n)).not.toBe(a);
  });
});

describe("isStuckForeignRecord", () => {
  const OWNER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SOURCE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("flags a non-source forward record when the network copy is terminal", () => {
    expect(
      isStuckForeignRecord(
        { phase: "forward", src: SOURCE },
        { phase: "terminal" },
        OWNER,
      ),
    ).toBe(true);
  });

  it("does not flag a source's expected offered copy", () => {
    expect(
      isStuckForeignRecord(
        { phase: "forward", src: OWNER },
        { phase: "terminal" },
        OWNER,
      ),
    ).toBe(false);
  });

  it("is not stuck while the progressed copy is still forward", () => {
    expect(
      isStuckForeignRecord(
        { phase: "forward", src: SOURCE },
        { phase: "forward" },
        OWNER,
      ),
    ).toBe(false);
  });

  it("is not stuck when the own record is already terminal", () => {
    expect(
      isStuckForeignRecord(
        { phase: "terminal", src: SOURCE },
        { phase: "terminal" },
        OWNER,
      ),
    ).toBe(false);
  });

  it("is not stuck without an own or progressed record", () => {
    expect(isStuckForeignRecord(null, { phase: "terminal" }, OWNER)).toBe(false);
    expect(
      isStuckForeignRecord({ phase: "forward", src: SOURCE }, null, OWNER),
    ).toBe(false);
  });
});
