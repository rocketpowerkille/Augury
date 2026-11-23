import { randomBytes } from "node:crypto";
import {
  bytesToHex,
  concatBytes,
  decodePost,
  encodePost,
  encodeBytes32,
  encodeUint,
  postFromShare,
  roundKeys,
  shareFromPost,
  splitSeed,
  verifyShare,
  type Hex,
  type MemberIndex,
  type MemberShare,
  type RoundOpen,
  type SharePost,
} from "@augury/shared";
import { open, seal, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";

/**
 * The key committee: three members, one of whom deals each round.
 *
 * The dealer creates the round seed, publishes the round's public key with commitments to
 * the three seed parts, and seals each other member's share to that member's QoreSeal key.
 * After the round closes, members release their shares; any two rebuild the seed.
 *
 * Trust note: the dealer knows the seed for its own round (see THREAT_MODEL.md).
 * Security-relevant: changes here need review by the team's PQC/security member.
 */

export const SHARE_SEAL_PURPOSE = "augury-share";

const DELIVERY_AAD_DOMAIN = new TextEncoder().encode("augury-share-aad-v1");

/** Rotate the dealer every round. */
export function dealerFor(round: bigint): MemberIndex {
  return Number(round % 3n) as MemberIndex;
}

function deliveryAad(feedId: Hex, round: bigint, member: MemberIndex): Uint8Array {
  return concatBytes(DELIVERY_AAD_DOMAIN, encodeBytes32(feedId), encodeUint(round, 64), Uint8Array.of(member));
}

export interface DealArgs {
  sealChainId: string;
  feedId: Hex;
  round: bigint;
  closeHeight: bigint;
  /**
   * ML-KEM-1024 keys of members 0, 1 and 2, as published in the chain's KEM key registry.
   * Deliveries are sealed in QoreSeal's ML-KEM-only mode, because the registry holds the
   * ML-KEM key alone.
   */
  members: readonly [SealRecipient, SealRecipient, SealRecipient];
  /** Injectable for tests only. */
  seed?: Uint8Array;
}

export interface Delivery {
  member: MemberIndex;
  envelope: Uint8Array;
}

export interface Deal {
  open: RoundOpen;
  /** The dealer's own share, kept locally. */
  ownShare: MemberShare;
  /**
   * Every member's share sealed to that member, the dealer's own included. Posted to the
   * inbox, they let any member (the dealer too) recover its share after a restart.
   */
  deliveries: Delivery[];
}

export function dealRound(args: DealArgs): Deal {
  const dealer = dealerFor(args.round);
  const seed = args.seed ?? new Uint8Array(randomBytes(32));
  const keys = roundKeys(seed);
  const { shares, commitments } = splitSeed(seed, args.round);
  seed.fill(0);

  const deliveries: Delivery[] = shares.map((s) => ({
      member: s.member,
      envelope: seal({
        chainId: args.sealChainId,
        purpose: SHARE_SEAL_PURPOSE,
        mode: "mlkem",
        recipients: [{ mlkemPublicKey: args.members[s.member].mlkemPublicKey }],
        plaintext: encodePost(postFromShare(args.feedId, args.round, s)),
        aad: deliveryAad(args.feedId, args.round, s.member),
      }),
    }));

  return {
    open: {
      kind: "open",
      feedId: args.feedId,
      round: args.round,
      dealer,
      closeHeight: args.closeHeight,
      mlkemPublicKey: bytesToHex(keys.mlkemPublicKey),
      x25519PublicKey: bytesToHex(keys.x25519PublicKey),
      commitments,
    },
    ownShare: shares[dealer],
    deliveries,
  };
}

export interface AcceptArgs {
  sealChainId: string;
  member: MemberIndex;
  keys: SealKeyPair;
  open: RoundOpen;
  envelope: Uint8Array;
}

/** Open a delivered share and check it against the round's commitments. Throws if invalid. */
export function acceptDelivery(args: AcceptArgs): MemberShare {
  const plaintext = open({
    chainId: args.sealChainId,
    purpose: SHARE_SEAL_PURPOSE,
    envelope: args.envelope,
    keys: args.keys,
    aad: deliveryAad(args.open.feedId, args.open.round, args.member),
  });
  const post = decodePost(plaintext);
  if (!post || post.kind !== "share" || post.member !== args.member) {
    throw new Error("delivery is not this member's share");
  }
  if (post.feedId !== args.open.feedId.toLowerCase() || post.round !== args.open.round) {
    throw new Error("delivery is for another round");
  }
  const share = shareFromPost(post);
  if (!verifyShare(share, args.open.round, args.open.commitments)) {
    throw new Error("delivered share does not match the round's commitments");
  }
  return share;
}

/** The share post to publish once the round has closed. Refuses to release early. */
export function releaseShare(open: RoundOpen, share: MemberShare, currentHeight: bigint): SharePost {
  if (currentHeight <= open.closeHeight) {
    throw new Error(`round closes at height ${open.closeHeight}; not releasing at ${currentHeight}`);
  }
  return postFromShare(open.feedId, open.round, share);
}
