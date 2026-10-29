import { describe, expect, it } from "vitest";
import {
  actorStep,
  commonPrefixLength,
  isOctalAddress,
  isStuckForeignRecord,
  paymentId,
  planRoute,
} from "./payments";

const SRC = "1111111111111111111111111111111111111111111111111111111111111111";
const DST = "2222222222222222222222222222222222222222222222222222222222222222";

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

  it("rejects roots and ancestor endpoints", () => {
    expect(planRoute("", "1")).toEqual({ error: "source-at-lca" });
    expect(planRoute("1", "")).toEqual({ error: "destination-at-lca" });
    expect(planRoute("1", "12")).toEqual({ error: "source-at-lca" });
    expect(planRoute("12", "1")).toEqual({ error: "destination-at-lca" });
    expect(planRoute("12", "12")).toEqual({ error: "same-address" });
  });

  it("rejects malformed addresses", () => {
    expect(planRoute("18", "2")).toEqual({ error: "invalid-address" });
    expect(planRoute("1", "x")).toEqual({ error: "invalid-address" });
  });
});

describe("actorStep", () => {
  const route = planRoute("125", "134");
  if ("error" in route) throw new Error("test route must plan");

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
    const short = planRoute("12", "13");
    if ("error" in short) throw new Error("test route must plan");
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
