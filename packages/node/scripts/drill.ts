/**
 * Fraud drill: act as a dishonest sequencer. Build the honest batch for a closed round from
 * the inbox, replace its median with a lie, sign that header with the sequencer's real
 * ML-DSA-87 key and post it. The hub accepts it (the signature is genuine); a watchtower
 * must then prove the lie on chain with `challengeBatch`, which slashes the sequencer's bond.
 *
 *   node packages/node/scripts/drill.ts --account secrets/sequencer.json \
 *     --feed fBTC/USD --round 3 [--factor 2] [--execute]
 *
 * Testnet only. Without --execute it prints the honest and the lying batch and sends nothing.
 */
import { parseArgs } from "node:util";
import {
  HubSender,
  InboxReader,
  loadAccount,
  loadChainView,
  loadDeployment,
  NativeSender,
  postBatchCalldata,
  publicClient,
  roundConfig,
  testnet,
} from "@augury/chain";
import { buildBatch } from "@augury/sequencer";
import { FEEDS, signBatch, type Hex } from "@augury/shared";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    feed: { type: "string", default: "fBTC/USD" },
    round: { type: "string" },
    factor: { type: "string", default: "2" },
    deployment: { type: "string", default: "deployments/testnet.json" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account || !values.round || !(values.feed in FEEDS)) {
  console.log("usage: drill.ts --account secrets/sequencer.json --feed fBTC/USD --round <n> [--factor 2] [--execute]");
  process.exit(1);
}

const net = testnet();
const deployment = loadDeployment(values.deployment);
const cfg = roundConfig(net, deployment);
const account = await loadAccount(values.account);
const feedId = FEEDS[values.feed as keyof typeof FEEDS];
const round = BigInt(values.round);

const reader = new InboxReader({ rest: net.rest, chainId: net.chainId, rollupId: deployment.rollupId });
const entries = await reader.read(0n, await reader.head());
const reporters: Hex[] = [
  ...new Set(
    entries
      .filter((e) => e.post.kind === "report" && e.post.feedId === feedId && e.post.round === round)
      .map((e) => e.poster),
  ),
];
const view = await loadChainView(publicClient(net), deployment.hub, reporters);
const honest = buildBatch(cfg, view, entries, feedId, round, account.pqc.secretKey);
if (!honest.batch) {
  console.log(`round ${round} of ${values.feed} is not ready: ${honest.outcome.status}`);
  process.exit(1);
}

const lyingHeader = { ...honest.batch.header, price: honest.batch.header.price * BigInt(values.factor) };
const lie = {
  header: lyingHeader,
  reports: honest.batch.reports,
  signature: signBatch(account.pqc.secretKey, cfg.domain, lyingHeader),
};
console.log(`round ${round} of ${values.feed}: ${honest.batch.reports.length} valid reports`);
console.log(`  honest median: ${honest.batch.header.price}`);
console.log(`  posted lie:    ${lyingHeader.price} (signed with the sequencer's real ML-DSA-87 key)`);
if (!values.execute) {
  console.log("dry run: nothing was sent. Add --execute to post the lying batch.");
  process.exit(0);
}

const native = await NativeSender.connect(net, account);
const tx = await new HubSender({ net, hub: deployment.hub, account, native }).send(postBatchCalldata(lie));
native.disconnect();
console.log(`lying batch posted (tx ${tx.hash}, ${tx.status}). A watchtower should now challenge it.`);
