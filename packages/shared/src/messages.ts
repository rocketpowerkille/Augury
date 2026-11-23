import {
  decodeInt256At,
  decodeUintAt,
  encodeAddress,
  encodeBytes32,
  encodeInt256,
  encodeUint,
  wordAt,
} from "./abi.ts";
import { bytesEqual, bytesToHex, concatBytes, hexToBytes, sha256, type Hex } from "./bytes.ts";

/**
 * Byte-exact mirrors of the messages AuguryHub signs and checks. Each one equals the
 * contract's `abi.encode(...)` of the same fields, so a signature made here verifies
 * on chain through the pqcVerify precompile.
 */

/** keccak256 of each tag string, as declared in AuguryHub. Checked against the contract in tests. */
export const TAGS = {
  report: "0xde27b797c84cbdc91a7c574a77ca25092b7ae1342f803884235a3775df6eafba",
  batch: "0x2360d05af57c90d2666345da3fbbeaa6d5b62565e01282b906e9abf7287cd413",
  reporterExit: "0x0b419c48f0845fdbb68f3a9f58252d2d204e4588774a4262a5b6c0d87e1e4145",
  reporterWithdraw: "0x37b6364c94d7831cde44bed5ea7b3fff4290cd7077dc378636c7d49078ce0280",
  bondExit: "0xd3f71b1069ddbdf62902805fa93b167435cbf4e222e024f61b4385e0a3004789",
  bondWithdraw: "0x79f6289368f958a018d2301d4c6726046720deb86fd682c2cfad240dc6107453",
} as const satisfies Record<string, Hex>;

/** Where messages are valid: the EVM chain id and the AuguryHub address. */
export interface Domain {
  chainId: bigint;
  hub: Hex;
}

export interface Report {
  feedId: Hex;
  round: bigint;
  reporter: Hex;
  /** Price with 8 decimals. */
  price: bigint;
  /** Unix seconds when the reporter observed the price. */
  observedAt: bigint;
  /**
   * 32 random bytes chosen by the reporter. The signature is published before the round
   * closes while the rest stays sealed; the salt stops anyone testing candidate prices
   * against that public signature.
   */
  salt: Hex;
}

export interface BatchHeader {
  feedId: Hex;
  round: bigint;
  price: bigint;
  reportRoot: Hex;
  reportCount: number;
}

function head(tag: Hex, d: Domain): Uint8Array[] {
  return [encodeBytes32(tag), encodeUint(d.chainId), encodeAddress(d.hub)];
}

export function reportMessage(d: Domain, r: Report): Uint8Array {
  return concatBytes(
    ...head(TAGS.report, d),
    encodeBytes32(r.feedId),
    encodeUint(r.round, 64),
    encodeAddress(r.reporter),
    encodeInt256(r.price),
    encodeUint(r.observedAt, 64),
    encodeBytes32(r.salt),
  );
}

/** Length of a report message: nine 32-byte words. */
export const REPORT_MESSAGE_LENGTH = 9 * 32;

/**
 * Read a report message back into its fields. Throws if the message is not a report for
 * domain `d`, so a message signed for another chain or hub is never accepted.
 */
export function decodeReportMessage(d: Domain, message: Uint8Array): Report {
  if (message.length !== REPORT_MESSAGE_LENGTH) {
    throw new Error(`report message must be ${REPORT_MESSAGE_LENGTH} bytes`);
  }
  if (!bytesEqual(wordAt(message, 0), hexToBytes(TAGS.report))) throw new Error("not a report");
  if (decodeUintAt(message, 1) !== d.chainId) throw new Error("report for another chain");
  if (!bytesEqual(wordAt(message, 2), encodeAddress(d.hub))) throw new Error("report for another hub");
  const report: Report = {
    feedId: bytesToHex(wordAt(message, 3)),
    round: decodeUintAt(message, 4),
    reporter: bytesToHex(wordAt(message, 5).slice(12)),
    price: decodeInt256At(message, 6),
    observedAt: decodeUintAt(message, 7),
    salt: bytesToHex(wordAt(message, 8)),
  };
  // Re-encoding must give the same bytes: this rejects out-of-range values and dirty padding.
  if (!bytesEqual(reportMessage(d, report), message)) throw new Error("malformed report message");
  return report;
}

export function batchMessage(d: Domain, b: BatchHeader): Uint8Array {
  return concatBytes(
    ...head(TAGS.batch, d),
    encodeBytes32(b.feedId),
    encodeUint(b.round, 64),
    encodeInt256(b.price),
    encodeBytes32(b.reportRoot),
    encodeUint(b.reportCount, 32),
  );
}

export type ExitTag = typeof TAGS.reporterExit | typeof TAGS.bondExit;
export type WithdrawTag = typeof TAGS.reporterWithdraw | typeof TAGS.bondWithdraw;

export function exitMessage(d: Domain, tag: ExitTag, account: Hex, nonce: bigint): Uint8Array {
  return concatBytes(...head(tag, d), encodeAddress(account), encodeUint(nonce, 64));
}

export function withdrawMessage(
  d: Domain,
  tag: WithdrawTag,
  account: Hex,
  to: Hex,
  nonce: bigint,
): Uint8Array {
  return concatBytes(
    ...head(tag, d),
    encodeAddress(account),
    encodeAddress(to),
    encodeUint(nonce, 64),
  );
}

/** Leaf of a batch's report root: SHA-256 of the report's signed message. */
export function reportLeaf(d: Domain, r: Report): Uint8Array {
  return sha256(reportMessage(d, r));
}

/** SHA-256 of the concatenated leaves, in batch order. Matches AuguryHub.challengeBatch. */
export function reportRoot(d: Domain, reports: readonly Report[]): Uint8Array {
  return sha256(concatBytes(...reports.map((r) => reportLeaf(d, r))));
}
