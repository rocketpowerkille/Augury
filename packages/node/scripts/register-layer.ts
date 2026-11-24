/**
 * Register the rollup's settlement layer in x/multilayer if it is missing. Anchored batches
 * (and so settlement receipts) need it. See registerLayerMessage for why it can be missing.
 *
 *   node packages/node/scripts/register-layer.ts --account secrets/sequencer.json [--execute]
 */
import { parseArgs } from "node:util";
import { loadAccount, loadDeployment, NativeSender, registerLayerMessage, testnet } from "@augury/chain";
import { isRestNotFound, RestClient } from "@qorechain/rdk";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    deployment: { type: "string", default: "deployments/testnet.json" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account) {
  console.log("usage: register-layer.ts --account secrets/sequencer.json [--execute]");
  process.exit(1);
}

const net = testnet();
const deployment = loadDeployment(values.deployment);
const account = await loadAccount(values.account);
const rest = new RestClient(net.rest);
const rollup = await rest.getRollup(deployment.rollupId);
if (rollup.creator !== account.cosmos) throw new Error("only the rollup's creator should register its layer");

const res = await fetch(`${net.rest}/qorechain/multilayer/v1/layers?pagination.limit=200`);
const layers = ((await res.json()) as { layers?: { layer_id: string }[] }).layers ?? [];
if (layers.some((l) => l.layer_id === rollup.layerId)) {
  console.log(`layer ${rollup.layerId} is already registered`);
  process.exit(0);
}
try {
  await rest.getAnchor(rollup.layerId);
} catch (err) {
  if (!isRestNotFound(err)) throw err;
}
console.log(`layer ${rollup.layerId} is not registered; it would be registered as a sidechain by ${account.cosmos}`);
if (!values.execute) {
  console.log("dry run: nothing was sent. Add --execute to register it.");
  process.exit(0);
}
const native = await NativeSender.connect(net, account);
const tx = await native.send([registerLayerMessage(account.cosmos, deployment.rollupId, rollup.profile)]);
native.disconnect();
console.log(`layer registered (tx ${tx.hash})`);
