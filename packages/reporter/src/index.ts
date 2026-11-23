import {
  bytesToHex,
  hexToBytes,
  newSalt,
  sealReport,
  signReport,
  type Domain,
  type Hex,
  type RoundOpen,
  type SealedReportPost,
  type SignaturePost,
} from "@augury/shared";

export * from "./sources.ts";

export interface BuildReportArgs {
  domain: Domain;
  sealChainId: string;
  /** The reporter's EVM address; it must also be the account that posts the report. */
  reporter: Hex;
  /** The reporter's ML-DSA-87 secret key (the one registered on chain). */
  secretKey: Uint8Array;
  open: RoundOpen;
  /** Price with 8 decimals. */
  price: bigint;
  /** Unix seconds when the price was observed. */
  observedAt: bigint;
  /** Fresh random salt; injectable for tests only. */
  salt?: Hex;
}

/**
 * Sign the observation with ML-DSA-87 (salt included) and build its two inbox posts: the
 * message sealed to the round key, then the signature. Post both in one transaction, in
 * this order, so they sit next to each other in the inbox.
 */
export function buildReportPosts(args: BuildReportArgs): [SealedReportPost, SignaturePost] {
  if (args.price <= 0n) throw new Error("price must be positive");
  const signed = signReport(args.secretKey, args.domain, {
    feedId: args.open.feedId,
    round: args.open.round,
    reporter: args.reporter,
    price: args.price,
    observedAt: args.observedAt,
    salt: args.salt ?? newSalt(),
  });
  const envelope = sealReport({
    sealChainId: args.sealChainId,
    domain: args.domain,
    recipient: {
      mlkemPublicKey: hexToBytes(args.open.mlkemPublicKey),
      x25519PublicKey: hexToBytes(args.open.x25519PublicKey),
    },
    report: signed,
  });
  return [
    { kind: "report", feedId: args.open.feedId, round: args.open.round, envelope: bytesToHex(envelope) },
    { kind: "signature", feedId: args.open.feedId, round: args.open.round, signature: bytesToHex(signed.signature) },
  ];
}
