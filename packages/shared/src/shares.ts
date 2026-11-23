import { randomBytes } from "node:crypto";
import { encodeUint } from "./abi.ts";
import { bytesEqual, bytesToHex, concatBytes, hexToBytes, sha256, type Hex } from "./bytes.ts";

/**
 * 2-of-3 replicated secret sharing of a round-key seed.
 *
 * The seed is split into three random parts with seed = p0 XOR p1 XOR p2. Committee member m
 * holds the two parts whose index is not m. Any two members together hold all three parts
 * and can rebuild the seed; one member alone is missing a uniformly random part and learns
 * nothing about the seed.
 *
 * When a round opens, a SHA-256 commitment to each part is published. A member who later
 * releases a wrong part is caught, because the part no longer matches its commitment.
 *
 * Security-relevant: changes here need review by the team's PQC/security member.
 */

export const SEED_LENGTH = 32;
export const COMMITTEE_SIZE = 3;

export type MemberIndex = 0 | 1 | 2;
export type PartIndex = 0 | 1 | 2;

export interface SharePart {
  index: PartIndex;
  value: Uint8Array;
}

/** What committee member `member` holds for one round: the two parts other than `member`. */
export interface MemberShare {
  member: MemberIndex;
  parts: [SharePart, SharePart];
}

export interface SplitSeed {
  shares: [MemberShare, MemberShare, MemberShare];
  /** Commitment to part 0, 1 and 2, published when the round opens. */
  commitments: [Hex, Hex, Hex];
}

const COMMIT_DOMAIN = new TextEncoder().encode("augury-round-share-v1");

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** Commitment binding a part to its round and index. */
export function partCommitment(round: bigint, index: PartIndex, value: Uint8Array): Hex {
  return bytesToHex(
    sha256(concatBytes(COMMIT_DOMAIN, encodeUint(round, 64), Uint8Array.of(index), value)),
  );
}

/** Split `seed` for `round`. `random` is injectable for deterministic tests only. */
export function splitSeed(
  seed: Uint8Array,
  round: bigint,
  random: (n: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n)),
): SplitSeed {
  if (seed.length !== SEED_LENGTH) throw new Error(`seed must be ${SEED_LENGTH} bytes`);
  const p0 = random(SEED_LENGTH);
  const p1 = random(SEED_LENGTH);
  const p2 = xor(xor(seed, p0), p1);
  const parts = [p0, p1, p2] as const;

  const share = (member: MemberIndex): MemberShare => {
    const held = ([0, 1, 2] as const).filter((i) => i !== member);
    return {
      member,
      parts: [
        { index: held[0]!, value: parts[held[0]!] },
        { index: held[1]!, value: parts[held[1]!] },
      ],
    };
  };

  return {
    shares: [share(0), share(1), share(2)],
    commitments: [
      partCommitment(round, 0, p0),
      partCommitment(round, 1, p1),
      partCommitment(round, 2, p2),
    ],
  };
}

/** True if every part of `share` matches its published commitment. */
export function verifyShare(share: MemberShare, round: bigint, commitments: readonly Hex[]): boolean {
  return share.parts.every((p) => {
    const expected = commitments[p.index];
    return (
      expected !== undefined &&
      p.value.length === SEED_LENGTH &&
      bytesEqual(hexToBytes(partCommitment(round, p.index, p.value)), hexToBytes(expected))
    );
  });
}

/**
 * Rebuild the seed from the released shares. Throws if a share does not match its
 * commitment or if the shares do not cover all three parts.
 */
export function combineShares(
  shares: readonly MemberShare[],
  round: bigint,
  commitments: readonly Hex[],
): Uint8Array {
  const found = new Map<PartIndex, Uint8Array>();
  for (const share of shares) {
    if (!verifyShare(share, round, commitments)) {
      throw new Error(`share of member ${share.member} does not match its commitments`);
    }
    for (const p of share.parts) found.set(p.index, p.value);
  }
  const p0 = found.get(0);
  const p1 = found.get(1);
  const p2 = found.get(2);
  if (!p0 || !p1 || !p2) throw new Error("need shares from two different committee members");
  return xor(xor(p0, p1), p2);
}
