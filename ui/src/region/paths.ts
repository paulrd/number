/**
 * Region path codec (a–h ↔ 0–7).
 *
 * A path is one digit per trie level. Digit order is the trie's preorder, so a
 * shorter path that prefixes a longer one sorts first — and because three bits
 * per digit are packed with zero padding, packed bytes are NOT comparable
 * (e.g. "a" and "aa" both encode to 0x00). Always compare decoded digits.
 */

export const MAX_PATH_LEN = 32;

/** Decode a zone address: zero-based slot digits, "" is the root path. */
export function addressToPath(address: string): number[] {
  const digits: number[] = [];
  for (const character of address) {
    const code = character.charCodeAt(0);
    if (code < 48 || code > 55) {
      throw new Error(`region address "${address}" contains a non 0-7 character`);
    }
    digits.push(code - 48);
  }
  return digits;
}

/** Encode a path as a zone address: zero-based slot digits, "" is the root. */
export function pathToAddress(digits: readonly number[]): string {
  let text = "";
  for (const digit of digits) {
    if (!Number.isInteger(digit) || digit < 0 || digit > 7) {
      throw new Error(`region address digit ${digit} is not 0-7`);
    }
    text += String(digit);
  }
  return text;
}

export function parsePath(text: string, maxDepth: number = MAX_PATH_LEN): number[] {
  if (text.length === 0 || text.length > maxDepth) {
    throw new Error(`region path "${text}" has an invalid length (1..=${maxDepth})`);
  }
  const digits: number[] = [];
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 97 || code > 104) {
      throw new Error(`region path "${text}" contains a non a-h character`);
    }
    digits.push(code - 97);
  }
  return digits;
}

export function pathLetters(digits: readonly number[]): string {
  let text = "";
  for (const digit of digits) {
    if (!Number.isInteger(digit) || digit < 0 || digit > 7) {
      throw new Error(`region path digit ${digit} is not 0-7`);
    }
    text += String.fromCharCode(97 + digit);
  }
  return text;
}

/** Three bits per digit, most-significant first, zero-padded. */
export function packPath(digits: readonly number[]): Uint8Array {
  const length = Math.ceil((3 * digits.length) / 8);
  const out = new Uint8Array(length);
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const digit of digits) {
    if (!Number.isInteger(digit) || digit < 0 || digit > 7) {
      throw new Error(`region path digit ${digit} is not 0-7`);
    }
    accumulator = ((accumulator << 3) | digit) >>> 0;
    bits += 3;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (accumulator >>> bits) & 0xff;
    }
  }
  if (bits > 0) {
    out[index] = (accumulator << (8 - bits)) & 0xff;
  }
  return out;
}

export function unpackPath(bytes: Uint8Array, length: number): number[] {
  const expected = Math.ceil((3 * length) / 8);
  if (bytes.length !== expected) {
    throw new Error(`packed path is ${bytes.length} bytes, expected ${expected}`);
  }
  const digits: number[] = [];
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  while (digits.length < length) {
    while (bits < 3) {
      if (index >= bytes.length) {
        throw new Error("packed path ended before all digits were read");
      }
      accumulator = ((accumulator << 8) | bytes[index++]!) >>> 0;
      bits += 8;
    }
    bits -= 3;
    digits.push((accumulator >>> bits) & 7);
  }
  return digits;
}

/** Preorder: compare digit by digit; a prefix sorts before its extension. */
export function comparePaths(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) {
      return a[index]! < b[index]! ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}
