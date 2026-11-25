import { bytesToHex, concatBytes, hexToBytes, type Hex } from "./bytes.ts";
import type { MemberIndex, MemberShare, PartIndex } from "./shares.ts";

/**
 * What Augury posts to the rollup inbox, in a compact binary format. QoreChain fixes the
 * order of inbox entries and records each entry's block height and poster, which is what
 * makes the round rules below deterministic. A qledger-v1 rollup accepts posts of at most
 * 6,144 bytes, so every post here stays below that.
 *
 * Round rules:
 * - A round starts with a `RoundOpen` posted by that round's dealer (a committee member).
 * - A report is two posts from the reporter, in one transaction so they sit next to each
 *   other in the inbox: the sealed report, then its signature. They count if posted after
 *   the open and at or before `closeHeight`.
 * - Shares count only if posted after `closeHeight`; an earlier share is an early release.
 */

/** The chain's limit on one qledger-v1 post. */
export const MAX_POST_BYTES = 6144;

const MAGIC = [0x41, 0x55, 0x47, 0x02] as const; // "AUG" + format version 2
const KIND = { open: 1, report: 2, signature: 3, share: 4, delivery: 5, "private-value": 6, "epoch-key": 7 } as const;
const ML_KEM_1024_PUBLIC_KEY = 1568;
const X25519_PUBLIC_KEY = 32;
const ML_DSA_87_SIGNATURE = 4627;

export interface RoundOpen {
  kind: "open";
  feedId: Hex;
  round: bigint;
  dealer: MemberIndex;
  /** Inbox height after which no more reports count and shares may be released. */
  closeHeight: bigint;
  /** The round key's public half (QoreSeal recipient). */
  mlkemPublicKey: Hex;
  x25519PublicKey: Hex;
  /** Commitments to seed parts 0, 1 and 2. */
  commitments: [Hex, Hex, Hex];
}

/** A report's signed message (salt included), sealed to the round key. */
export interface SealedReportPost {
  kind: "report";
  feedId: Hex;
  round: bigint;
  envelope: Hex;
}

/** The ML-DSA-87 signature of the sealed report posted just before it. */
export interface SignaturePost {
  kind: "signature";
  feedId: Hex;
  round: bigint;
  signature: Hex;
}

export interface SharePost {
  kind: "share";
  feedId: Hex;
  round: bigint;
  member: MemberIndex;
  parts: [{ index: PartIndex; value: Hex }, { index: PartIndex; value: Hex }];
}

/** A member's seed parts, sealed by the dealer to that member's QoreSeal key. */
export interface DeliveryPost {
  kind: "delivery";
  feedId: Hex;
  round: bigint;
  member: MemberIndex;
  envelope: Hex;
}

/** A private feed's value, sealed with the feed's current QoreSeal epoch key (see privatefeed.ts). */
export interface PrivateValuePost {
  kind: "private-value";
  feedId: Hex;
  round: bigint;
  blob: Hex;
}

/** A private feed's epoch key sealed to its subscribers. `round` carries the epoch number. */
export interface EpochKeyPost {
  kind: "epoch-key";
  feedId: Hex;
  round: bigint;
  envelope: Hex;
}

export type InboxPost =
  | RoundOpen
  | SealedReportPost
  | SignaturePost
  | SharePost
  | DeliveryPost
  | PrivateValuePost
  | EpochKeyPost;

/** One inbox entry as read from the chain. */
export interface InboxEntry {
  /** Position in the rollup inbox. */
  seq: bigint;
  /** Block height at which the entry was included. */
  height: bigint;
  /** EVM address of the account that posted it. */
  poster: Hex;
  post: InboxPost;
}

// ------------------------------------------------------------------------------------------
// Encoding
// ------------------------------------------------------------------------------------------

function u64(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new RangeError(`not a uint64: ${v}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v);
  return out;
}

function fixed(hex: Hex, length: number, name: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== length) throw new Error(`${name} must be ${length} bytes`);
  return bytes;
}

export function encodePost(post: InboxPost): Uint8Array {
  const head = concatBytes(
    Uint8Array.from(MAGIC),
    Uint8Array.of(KIND[post.kind]),
    fixed(post.feedId, 32, "feedId"),
    u64(post.round),
  );
  let body: Uint8Array;
  switch (post.kind) {
    case "open":
      body = concatBytes(
        Uint8Array.of(post.dealer),
        u64(post.closeHeight),
        fixed(post.mlkemPublicKey, ML_KEM_1024_PUBLIC_KEY, "mlkemPublicKey"),
        fixed(post.x25519PublicKey, X25519_PUBLIC_KEY, "x25519PublicKey"),
        ...post.commitments.map((c) => fixed(c, 32, "commitment")),
      );
      break;
    case "report":
      body = hexToBytes(post.envelope);
      break;
    case "signature":
      body = fixed(post.signature, ML_DSA_87_SIGNATURE, "signature");
      break;
    case "share":
      body = concatBytes(
        Uint8Array.of(post.member),
        ...post.parts.map((p) => concatBytes(Uint8Array.of(p.index), fixed(p.value, 32, "part"))),
      );
      break;
    case "delivery":
      body = concatBytes(Uint8Array.of(post.member), hexToBytes(post.envelope));
      break;
    case "private-value":
      body = hexToBytes(post.blob);
      break;
    case "epoch-key":
      body = hexToBytes(post.envelope);
      break;
  }
  const out = concatBytes(head, body);
  if (out.length > MAX_POST_BYTES) throw new Error(`${post.kind} post is ${out.length} bytes; the limit is ${MAX_POST_BYTES}`);
  return out;
}

/** Parse an inbox payload. Returns `undefined` for anything that is not a valid Augury post. */
export function decodePost(data: Uint8Array): InboxPost | undefined {
  const HEAD = 4 + 1 + 32 + 8;
  if (data.length < HEAD || MAGIC.some((b, i) => data[i] !== b)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = data[4];
  const feedId = bytesToHex(data.subarray(5, 37));
  const round = view.getBigUint64(37);
  const body = data.subarray(HEAD);
  const member = (v: number | undefined): MemberIndex | undefined => (v === 0 || v === 1 || v === 2 ? v : undefined);

  switch (kind) {
    case KIND.open: {
      if (body.length !== 1 + 8 + ML_KEM_1024_PUBLIC_KEY + X25519_PUBLIC_KEY + 3 * 32) return undefined;
      const dealer = member(body[0]);
      if (dealer === undefined) return undefined;
      let o = 9;
      const take = (n: number) => bytesToHex(body.subarray(o, (o += n)));
      return {
        kind: "open",
        feedId,
        round,
        dealer,
        closeHeight: new DataView(body.buffer, body.byteOffset + 1, 8).getBigUint64(0),
        mlkemPublicKey: take(ML_KEM_1024_PUBLIC_KEY),
        x25519PublicKey: take(X25519_PUBLIC_KEY),
        commitments: [take(32), take(32), take(32)],
      };
    }
    case KIND.report:
      if (body.length === 0) return undefined;
      return { kind: "report", feedId, round, envelope: bytesToHex(body) };
    case KIND.signature:
      if (body.length !== ML_DSA_87_SIGNATURE) return undefined;
      return { kind: "signature", feedId, round, signature: bytesToHex(body) };
    case KIND.share: {
      if (body.length !== 1 + 2 * 33) return undefined;
      const m = member(body[0]);
      const i0 = member(body[1]);
      const i1 = member(body[34]);
      if (m === undefined || i0 === undefined || i1 === undefined) return undefined;
      return {
        kind: "share",
        feedId,
        round,
        member: m,
        parts: [
          { index: i0, value: bytesToHex(body.subarray(2, 34)) },
          { index: i1, value: bytesToHex(body.subarray(35, 67)) },
        ],
      };
    }
    case KIND.delivery: {
      const m = member(body[0]);
      if (m === undefined || body.length < 2) return undefined;
      return { kind: "delivery", feedId, round, member: m, envelope: bytesToHex(body.subarray(1)) };
    }
    case KIND["private-value"]:
      if (body.length === 0) return undefined;
      return { kind: "private-value", feedId, round, blob: bytesToHex(body) };
    case KIND["epoch-key"]:
      if (body.length === 0) return undefined;
      return { kind: "epoch-key", feedId, round, envelope: bytesToHex(body) };
    default:
      return undefined;
  }
}

/** A share post as the `MemberShare` the shares module works with. */
export function shareFromPost(post: SharePost): MemberShare {
  return {
    member: post.member,
    parts: [
      { index: post.parts[0].index, value: hexToBytes(post.parts[0].value) },
      { index: post.parts[1].index, value: hexToBytes(post.parts[1].value) },
    ],
  };
}

export function postFromShare(feedId: Hex, round: bigint, share: MemberShare): SharePost {
  return {
    kind: "share",
    feedId,
    round,
    member: share.member,
    parts: [
      { index: share.parts[0].index, value: bytesToHex(share.parts[0].value) },
      { index: share.parts[1].index, value: bytesToHex(share.parts[1].value) },
    ],
  };
}
