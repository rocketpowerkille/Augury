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
  type Layer,
  type MemberIndex,
  type MemberShare,
  type RoundOpen,
  type SharePost,
} from "@augury/shared";
import { open, seal, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";

/**
 * The key committee: three members, two of whom deal each round.
 *
 * Each dealer creates its own seed, publishes its key with commitments to the three seed
 * parts, and seals each member's share to that member's QoreSeal key. Reports are sealed to
 * both keys, layer 0 inside layer 1. After the round closes, members release their shares
 * of both seeds; any two members rebuild both.
 *
 * Trust: each dealer knows only its own seed, so no single member can open reports before
 * the close; two colluding members still can (see THREAT_MODEL.md).
 * Security-relevant: changes here need review by the team's PQC/security member.
 */

export const SHARE_SEAL_PURPOSE = "augury-share";

const DELIVERY_AAD_DOMAIN = new TextEncoder().encode("augury-share-aad-v1");

/** Rotate the dealer every round: the layer 0 dealer. */
export function dealerFor(round: bigint): MemberIndex {
  return Number(round % 3n) as MemberIndex;
}

/** The dealer of a layer: layer 0 rotates with the round, layer 1 is the next member. */
export function layerDealerFor(round: bigint, layer: Layer): MemberIndex {
  return Number((round + BigInt(layer)) % 3n) as MemberIndex;
}

/** Binds a delivery to its feed, round, member and, for layer 1, its layer. */
function deliveryAad(feedId: Hex, round: bigint, member: MemberIndex, layer: Layer | undefined): Uint8Array {
  return concatBytes(
    DELIVERY_AAD_DOMAIN,
    encodeBytes32(feedId),
    encodeUint(round, 64),
    Uint8Array.of(member),
    layer === undefined ? new Uint8Array(0) : Uint8Array.of(layer),
  );
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
  /**
   * Which key of a two-dealer round to deal. Omit both `layer` and `layers` for a
   * single-dealer round. Layer 0 is dealt with `layers: 2`; layer 1 follows once layer 0's
   * open is on the inbox, with the same close height.
   */
  layer?: Layer;
  layers?: 1 | 2;
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
  const layered = args.layer !== undefined || args.layers !== undefined;
  const layer: Layer | undefined = layered ? (args.layer ?? 0) : undefined;
  const dealer = layerDealerFor(args.round, layer ?? 0);
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
        plaintext: encodePost(postFromShare(args.feedId, args.round, s, layer)),
        aad: deliveryAad(args.feedId, args.round, s.member, layer),
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
      ...(layered ? { layer: layer!, layers: layer === 1 ? 2 : (args.layers ?? 2) } : {}),
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
    aad: deliveryAad(args.open.feedId, args.open.round, args.member, args.open.layer),
  });
  const post = decodePost(plaintext);
  if (!post || post.kind !== "share" || post.member !== args.member) {
    throw new Error("delivery is not this member's share");
  }
  if (post.layer !== args.open.layer) throw new Error("delivery is for another layer");
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
  return postFromShare(open.feedId, open.round, share, open.layer);
}
