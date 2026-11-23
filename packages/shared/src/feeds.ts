import { bytesToHex, sha256, type Hex } from "./bytes.ts";

/** Every Augury price has 8 decimals, like AuguryHub.DECIMALS. */
export const PRICE_DECIMALS = 8;

/** Feed id of a named feed: SHA-256 of `augury-feed:<name>`. AuguryHub treats it as opaque. */
export function feedId(name: string): Hex {
  return bytesToHex(sha256(new TextEncoder().encode(`augury-feed:${name}`)));
}

export const FEEDS = {
  "fBTC/USD": feedId("fBTC/USD"),
  "fETH/USD": feedId("fETH/USD"),
  "QOR/USD": feedId("QOR/USD"),
} as const;

/** Convert a decimal price string such as "97123.45" to an 8-decimal integer. */
export function parsePrice(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`not a decimal price: ${text}`);
  const [, sign, whole, frac = ""] = match;
  if (frac.length > PRICE_DECIMALS) throw new Error(`more than ${PRICE_DECIMALS} decimals: ${text}`);
  const value = BigInt(whole! + frac.padEnd(PRICE_DECIMALS, "0"));
  return sign === "-" ? -value : value;
}
