/**
 * Stake QOR for a reporter on AuguryHub (anyone may fund any reporter's stake).
 *
 *   node packages/node/scripts/stake.ts --account secrets/<funder>.json --reporter 0x… \
 *     [--amount-qor 1] [--deployment deployments/testnet.json] [--execute]
 *
 * --reporter defaults to the account's own address.
 */
import { parseArgs } from "node:util";
import { HubSender, loadAccount, loadDeployment, NativeSender, stakeCalldata, testnet } from "@augury/chain";
import type { Hex } from "@augury/shared";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    reporter: { type: "string" },
    "amount-qor": { type: "string", default: "1" },
    deployment: { type: "string", default: "deployments/testnet.json" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account) {
  console.log("usage: stake.ts --account secrets/<funder>.json [--reporter 0x…] [--amount-qor 1] [--execute]");
  process.exit(1);
}

const net = testnet();
const deployment = loadDeployment(values.deployment);
const account = await loadAccount(values.account);
const reporter = (values.reporter ?? account.evm).toLowerCase() as Hex;
const amount = BigInt(values["amount-qor"]) * 10n ** 18n;

console.log(`stake ${values["amount-qor"]} QOR for reporter ${reporter} on hub ${deployment.hub}`);
if (!values.execute) {
  console.log("dry run: nothing was sent. Add --execute to stake.");
  process.exit(0);
}
const native = await NativeSender.connect(net, account);
const tx = await new HubSender({ net, hub: deployment.hub, account, native }).send(stakeCalldata(reporter), amount);
native.disconnect();
console.log(`staked (tx ${tx.hash}, ${tx.status})`);
