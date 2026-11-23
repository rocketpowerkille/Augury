import { bytesToHex, hexToBytes, type Hex } from "./bytes.ts";
import type { MemberIndex, MemberShare, PartIndex } from "./shares.ts";

/**
 * What Augury posts to the rollup inbox. Each post is UTF-8 JSON with a version tag; byte
 * fields are 0x-hex. QoreChain fixes the order of inbox entries and records each entry's
 * block height and poster, which is what makes the round rules below deterministic.
 *
 * Round rules:
 * - A round starts with a `RoundOpen` posted by that round's dealer (a committee member).
 * - A report counts if it is posted after the open and at or before `closeHeight`.
 * - Shares count only if posted after `closeHeight`; an earlier share is an early release.
 */

export const INBOX_VERSION = "augury/1";

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

export interface SealedReportPost {
  kind: "report";
  feedId: Hex;
  round: bigint;
  envelope: Hex;
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

export type InboxPost = RoundOpen | SealedReportPost | SharePost | DeliveryPost;

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

export function encodePost(post: InboxPost): Uint8Array {
  const json = JSON.stringify({ v: INBOX_VERSION, ...post }, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return new TextEncoder().encode(json);
}

/** Parse an inbox payload. Returns `undefined` for anything that is not a valid Augury post. */
export function decodePost(data: Uint8Array): InboxPost | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || raw.v !== INBOX_VERSION) return undefined;
  try {
    switch (raw.kind) {
      case "open":
        return {
          kind: "open",
          feedId: hex32(raw.feedId),
          round: uint(raw.round),
          dealer: member(raw.dealer),
          closeHeight: uint(raw.closeHeight),
          mlkemPublicKey: hex(raw.mlkemPublicKey),
          x25519PublicKey: hex(raw.x25519PublicKey),
          commitments: tuple3(raw.commitments).map(hex32) as [Hex, Hex, Hex],
        };
      case "report":
        return {
          kind: "report",
          feedId: hex32(raw.feedId),
          round: uint(raw.round),
          envelope: hex(raw.envelope),
        };
      case "delivery":
        return {
          kind: "delivery",
          feedId: hex32(raw.feedId),
          round: uint(raw.round),
          member: member(raw.member),
          envelope: hex(raw.envelope),
        };
      case "share": {
        const parts = raw.parts;
        if (!Array.isArray(parts) || parts.length !== 2) return undefined;
        return {
          kind: "share",
          feedId: hex32(raw.feedId),
          round: uint(raw.round),
          member: member(raw.member),
          parts: [part(parts[0]), part(parts[1])],
        };
      }
      default:
        return undefined;
    }
  } catch {
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

// ------------------------------------------------------------------------------------------
// Field validation
// ------------------------------------------------------------------------------------------

function hex(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error("bad hex");
  return v.toLowerCase() as Hex;
}

function hex32(v: unknown): Hex {
  const h = hex(v);
  if (h.length !== 66) throw new Error("expected 32 bytes");
  return h;
}

function uint(v: unknown): bigint {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("bad integer");
  return BigInt(v);
}

function member(v: unknown): MemberIndex {
  if (v !== 0 && v !== 1 && v !== 2) throw new Error("bad member index");
  return v;
}

function tuple3(v: unknown): [unknown, unknown, unknown] {
  if (!Array.isArray(v) || v.length !== 3) throw new Error("expected 3 items");
  return v as [unknown, unknown, unknown];
}

function part(v: unknown): { index: PartIndex; value: Hex } {
  if (v === null || typeof v !== "object") throw new Error("bad part");
  const p = v as Record<string, unknown>;
  return { index: member(p.index), value: hex32(p.value) };
}
