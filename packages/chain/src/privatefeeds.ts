import { bytesToHex, type Hex, type Publication } from "@augury/shared";
import { encodeFunctionData, type PublicClient } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { privateFeedsAbi, privateFeedsBytecode } from "./abi/privateFeeds.ts";
import { deployThroughWindow } from "./hub.ts";
import type { NativeSender } from "./native.ts";
import type { Network } from "./network.ts";

/** Deploy the PrivateFeeds contract from `account`. */
export async function deployPrivateFeeds(opts: {
  net: Network;
  account: UnifiedAccount;
  native: NativeSender;
  mldsaAlgorithmId: number;
}): Promise<{ address: Hex; txHash: Hex }> {
  return deployThroughWindow({
    ...opts,
    label: "PrivateFeeds",
    abi: privateFeedsAbi,
    bytecode: privateFeedsBytecode,
    args: [opts.mldsaAlgorithmId],
  });
}

/** Calldata for `PrivateFeeds.publish`. */
export function publishCalldata(publisher: Hex, p: Publication, signature: Uint8Array): Hex {
  return encodeFunctionData({
    abi: privateFeedsAbi,
    functionName: "publish",
    args: [publisher, p.feedId, p.round, p.epoch, p.commitment, p.blobHash, bytesToHex(signature)],
  });
}

/** What PrivateFeeds stored for `round` of `publisher`'s `feedId`, or undefined if nothing. */
export async function publicationOn(
  client: PublicClient,
  registry: Hex,
  publisher: Hex,
  feedId: Hex,
  round: bigint,
): Promise<{ commitment: Hex; blobHash: Hex; epoch: bigint; publishedAt: bigint } | undefined> {
  const [commitment, blobHash, epoch, publishedAt] = await client.readContract({
    address: registry,
    abi: privateFeedsAbi,
    functionName: "publications",
    args: [publisher, feedId, round],
  });
  return publishedAt === 0n ? undefined : { commitment, blobHash, epoch, publishedAt };
}

/** `PrivateFeeds.verifyValue`: whether an opened value is the one published. */
export async function verifyValueOn(
  client: PublicClient,
  registry: Hex,
  publisher: Hex,
  v: { feedId: Hex; round: bigint; value: bigint; observedAt: bigint; salt: Hex },
): Promise<boolean> {
  return client.readContract({
    address: registry,
    abi: privateFeedsAbi,
    functionName: "verifyValue",
    args: [publisher, v.feedId, v.round, v.value, v.observedAt, v.salt],
  });
}
