import { describe, expect, it } from "vitest";
import {
  addressToPath,
  comparePaths,
  packPath,
  parsePath,
  pathLetters,
  pathToAddress,
  unpackPath,
} from "./paths";

describe("region path codec", () => {
  it("matches the wire examples (padding makes packed bytes non-unique)", () => {
    expect(Array.from(packPath([0]))).toEqual([0x00]);
    expect(Array.from(packPath([0, 0]))).toEqual([0x00]);
    expect(Array.from(packPath([0, 1]))).toEqual([0x04]);
    expect(Array.from(packPath([1]))).toEqual([0x20]);
    expect(Array.from(packPath([1, 0]))).toEqual([0x20]);
  });

  it("round-trips every length from 1 to 32", () => {
    for (let length = 1; length <= 32; length += 1) {
      const digits = Array.from({ length }, (_, index) => (index * 3 + length) % 8);
      const packed = packPath(digits);
      expect(packed.length).toBe(Math.ceil((3 * length) / 8));
      expect(unpackPath(packed, length)).toEqual(digits);
    }
  });

  it("parses letters to digits and back", () => {
    expect(parsePath("aacbd")).toEqual([0, 0, 2, 1, 3]);
    expect(pathLetters([0, 0, 2, 1, 3])).toBe("aacbd");
    expect(parsePath("aacb", 4)).toEqual([0, 0, 2, 1]);
  });

  it("rejects empty, over-deep and non a-h paths", () => {
    expect(() => parsePath("")).toThrow(/invalid length/);
    expect(() => parsePath("abcdefgh", 7)).toThrow(/invalid length/);
    expect(() => parsePath("ai")).toThrow(/non a-h/);
    expect(() => pathLetters([8])).toThrow(/not 0-7/);
    expect(() => unpackPath(new Uint8Array(2), 1)).toThrow(/expected 1/);
  });

  it("compares a prefix before its extension and otherwise by digit", () => {
    expect(comparePaths(parsePath("a"), parsePath("aa"))).toBe(-1);
    expect(comparePaths(parsePath("aa"), parsePath("a"))).toBe(1);
    expect(comparePaths(parsePath("a"), parsePath("a"))).toBe(0);
    expect(comparePaths(parsePath("ab"), parsePath("b"))).toBe(-1);
    expect(comparePaths(parsePath("b"), parsePath("ab"))).toBe(1);
    expect(comparePaths(parsePath("aa"), parsePath("ab"))).toBe(-1);
  });

  it("round-trips addresses and their paths", () => {
    for (const address of ["", "0", "034", "7777777"]) {
      expect(pathToAddress(addressToPath(address))).toBe(address);
    }
    expect(addressToPath("034")).toEqual([0, 3, 4]);
    expect(pathToAddress([0, 3, 4])).toBe("034");
  });

  it("rejects non-digit addresses and non-digit path elements", () => {
    expect(() => addressToPath("8")).toThrow(/non 0-7/);
    expect(() => addressToPath("-")).toThrow(/non 0-7/);
    expect(() => addressToPath("a")).toThrow(/non 0-7/);
    expect(() => pathToAddress([8])).toThrow(/not 0-7/);
  });
});
