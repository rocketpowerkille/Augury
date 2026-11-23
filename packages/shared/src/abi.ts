import { hexToBytes } from "./bytes.ts";

/**
 * Minimal ABI encoding for static types. Every Augury message is `abi.encode` of static
 * fields only, so it is a plain sequence of 32-byte words.
 */

const WORD = 32;
const UINT256_MAX = (1n << 256n) - 1n;
const INT256_MIN = -(1n << 255n);
const INT256_MAX = (1n << 255n) - 1n;

function wordFromBigInt(value: bigint): Uint8Array {
  const out = new Uint8Array(WORD);
  let v = value;
  for (let i = WORD - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** `uintN` for any N <= 256. Throws if the value does not fit in `bits`. */
export function encodeUint(value: bigint | number, bits = 256): Uint8Array {
  const v = BigInt(value);
  const max = bits === 256 ? UINT256_MAX : (1n << BigInt(bits)) - 1n;
  if (v < 0n || v > max) throw new RangeError(`uint${bits} out of range: ${v}`);
  return wordFromBigInt(v);
}

/** `int256`, two's complement. */
export function encodeInt256(value: bigint): Uint8Array {
  if (value < INT256_MIN || value > INT256_MAX) throw new RangeError(`int256 out of range: ${value}`);
  return wordFromBigInt(value < 0n ? value + (1n << 256n) : value);
}

/** `address`: 20 bytes, left-padded with zeros. */
export function encodeAddress(address: string): Uint8Array {
  const raw = hexToBytes(address);
  if (raw.length !== 20) throw new Error(`address must be 20 bytes: ${address}`);
  const out = new Uint8Array(WORD);
  out.set(raw, WORD - 20);
  return out;
}

/** `bytes32`. */
export function encodeBytes32(value: string | Uint8Array): Uint8Array {
  const raw = typeof value === "string" ? hexToBytes(value) : value;
  if (raw.length !== WORD) throw new Error(`bytes32 must be 32 bytes, got ${raw.length}`);
  return Uint8Array.from(raw);
}
