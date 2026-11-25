/**
 * Run a private feed on the testnet: a publisher seals two values of a demo NAV feed with
 * QoreSeal epoch keys, posts them to the rollup inbox and publishes signed commitments on the
 * PrivateFeeds contract. Between the two values it removes the last subscriber, so the epoch
 * key rotates and that subscriber cannot read the second value. The script then reads the
 * posts back from the chain's inbox and opens them as each subscriber.
 *
 *   node packages/node/scripts/private-feed.ts --publisher secrets/sequencer.json \
 *     --subscriber secrets/committee-0.json --subscriber secrets/committee-1.json \
 *     [--nav 104.25] [--execute]
 *
 * Subscribers are known only by the ML-KEM-1024 key they published in the chain's KEM
 * registry (setup-account.ts --kem). The values are demo numbers, not a real fund's NAV.
 * The first --execute deploys PrivateFeeds and writes deployments/testnet-private-feeds.json.
 * Without --execute nothing is sent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  deployPrivateFeeds,
  evmAddress,
  fetchKemKeys,
  HubSender,
  inboxPostMessage,
  InboxReader,
  loadAccount,
  loadDeployment,
  NativeSender,
  privateFeedsAbi,
  publicationOn,
  publicClient,
  publishCalldata,
  testnet,
  verifyValueOn,
} from "@augury/chain";
import {
  bytesToHex,
  feedId,
  hexToBytes,
  ML_DSA_87_ALGORITHM_ID,
  parsePrice,
  PrivateFeedPublisher,
  PrivateFeedSubscriber,
  type Hex,
  type Publication,
} from "@augury/shared";
import { deriveSealKeys } from "@qorechain/qoreseal";

const { values } = parseArgs({
  options: {
    publisher: { type: "string" },
    subscriber: { type: "string", multiple: true, default: [] },
    nav: { type: "string", default: "104.25" },
    deployment: { type: "string", default: "deployments/testnet.json" },
    out: { type: "string", default: "deployments/testnet-private-feeds.json" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.publisher || values.subscriber.length < 2) {
  console.log("usage: private-feed.ts --publisher <file> --subscriber <file> --subscriber <file> [--nav 104.25] [--execute]");
  process.exit(1);
}

const FEED_NAME = "NAV/demo-fund";
const FEED = feedId(FEED_NAME);
const net = testnet();
const client = publicClient(net);
const deployment = loadDeployment(values.deployment);
const publisherAccount = await loadAccount(values.publisher);
const publisher = evmAddress(publisherAccount);
const subscriberAccounts = await Promise.all(values.subscriber.map((f) => loadAccount(f)));
const subscriberAddresses = subscriberAccounts.map(evmAddress);
const nav = parsePrice(values.nav);

// --- Checks (read-only) ----------------------------------------------------------------
const kemKeys = await fetchKemKeys(net.rest, subscriberAddresses).catch(() => {
  throw new Error("every subscriber needs an ML-KEM key in the KEM registry; run setup-account.ts --kem");
});
const existing = existsSync(values.out) ? (JSON.parse(readFileSync(values.out, "utf8")) as { registry: Hex }) : undefined;
console.log(`feed:        ${FEED_NAME} (${FEED})`);
console.log(`publisher:   ${publisher}`);
console.log(`subscribers: ${subscriberAddresses.join(", ")} (ML-KEM-1024 keys from the KEM registry)`);
console.log(`registry:    ${existing ? existing.registry : "PrivateFeeds will be deployed"}`);
console.log(`values:      round A = ${values.nav}, then remove ${subscriberAddresses.at(-1)}, round B = ${values.nav} + 0.01`);
if (!values.execute) {
  console.log("dry run: nothing was sent. Add --execute to run it.");
  process.exit(0);
}

// --- Run ---------------------------------------------------------------------------------
const native = await NativeSender.connect(net, publisherAccount);
let registry: Hex;
if (existing) {
  registry = existing.registry;
} else {
  const deployed = await deployPrivateFeeds({ net, account: publisherAccount, native, mldsaAlgorithmId: ML_DSA_87_ALGORITHM_ID });
  registry = deployed.address;
  writeFileSync(values.out, `${JSON.stringify({ network: "testnet", registry, deployTx: deployed.txHash }, null, 2)}\n`);
  console.log(`PrivateFeeds deployed at ${registry} (tx ${deployed.txHash}); wrote ${values.out}`);
}
const domain = { chainId: BigInt(net.evmChainId), registry };
const sender = new HubSender({ net, hub: registry, account: publisherAccount, native });
const feed = new PrivateFeedPublisher({
  sealChainId: net.chainId,
  domain,
  publisher,
  secretKey: publisherAccount.pqc.secretKey,
  feedId: FEED,
  mode: "mlkem",
});

const inbox = new InboxReader({ rest: net.rest, chainId: net.chainId, rollupId: deployment.rollupId });
const startSeq = await inbox.head();
const lastRound = await client.readContract({ address: registry, abi: privateFeedsAbi, functionName: "latestRound", args: [publisher, FEED] });

/** Post the epoch key and the sealed value in one native tx, then publish the signed commitment. */
async function publishRound(round: bigint, value: bigint, envelope: Uint8Array): Promise<Publication> {
  const out = feed.publish(round, value, BigInt(Math.floor(Date.now() / 1000)));
  const tx = await native.send([
    inboxPostMessage(native.address, deployment.rollupId, { kind: "epoch-key", feedId: FEED, round: feed.epoch, envelope: bytesToHex(envelope) }),
    inboxPostMessage(native.address, deployment.rollupId, { kind: "private-value", feedId: FEED, round, blob: bytesToHex(out.blob) }),
  ]);
  console.log(`round ${round}: epoch ${feed.epoch} key and sealed value posted to the inbox (tx ${tx.hash})`);
  const pub = await sender.send(publishCalldata(publisher, out.publication, out.signature));
  console.log(`round ${round}: commitment ${out.publication.commitment} published (tx ${pub.hash}, ${pub.status})`);
  return out.publication;
}

let rotation;
subscriberAddresses.forEach((addr, i) => (rotation = feed.addSubscriber(addr, { mlkemPublicKey: kemKeys[i]! })));
const roundA = await publishRound(lastRound + 1n, nav, rotation!.envelope!);
const removed = subscriberAddresses.at(-1)!;
const afterRemoval = feed.removeSubscriber(removed);
console.log(`removed ${removed}: epoch ${afterRemoval.epoch} is sealed only to ${afterRemoval.members.join(", ")}`);
const roundB = await publishRound(lastRound + 2n, nav + 1_000_000n, afterRemoval.envelope!);
native.disconnect();

// --- Read back from the chain and open as each subscriber ---------------------------------
const entries = (await inbox.read(startSeq, await inbox.head())).filter(
  (e) => e.post.feedId.toLowerCase() === FEED.toLowerCase() && e.poster.toLowerCase() === publisher.toLowerCase(),
);
for (const [i, account] of subscriberAccounts.entries()) {
  if (!account.mnemonic) throw new Error(`subscriber ${subscriberAddresses[i]} has no mnemonic to derive its KEM key from`);
  const sub = new PrivateFeedSubscriber({
    sealChainId: net.chainId,
    domain,
    publisher,
    feedId: FEED,
    keys: deriveSealKeys({ mnemonic: account.mnemonic }),
  });
  for (const e of entries) {
    if (e.post.kind !== "epoch-key") continue;
    try {
      sub.acceptEpochKey(hexToBytes(e.post.envelope));
    } catch {
      // Sealed to other subscribers only.
    }
  }
  for (const publication of [roundA, roundB]) {
    const blob = entries.find((e) => e.post.kind === "private-value" && e.post.round === publication.round);
    if (!blob || blob.post.kind !== "private-value") throw new Error(`round ${publication.round} not found in the inbox`);
    const onChain = await publicationOn(client, registry, publisher, FEED, publication.round);
    if (!onChain || onChain.commitment.toLowerCase() !== publication.commitment.toLowerCase()) {
      throw new Error(`round ${publication.round}: the chain does not hold the expected commitment`);
    }
    try {
      const v = sub.open({ blob: hexToBytes(blob.post.blob), publication });
      const proven = await verifyValueOn(client, registry, publisher, v);
      console.log(`subscriber ${subscriberAddresses[i]} round ${publication.round}: read ${v.value}, verifyValue on chain = ${proven}`);
    } catch (err) {
      console.log(`subscriber ${subscriberAddresses[i]} round ${publication.round}: cannot read (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
