/**
 * Settle the rollup: submit the next batch over its inbox, anchored with the rollup
 * creator's ML-DSA-87 signature, then build its settlement receipt and re-verify the receipt
 * against live chain state. Receipts are saved to receipts/<rollup>-<batch>.json.
 *
 *   node packages/node/scripts/settle.ts --account secrets/sequencer.json [--bond-qor 1000] [--execute]
 *
 * The chain admits a batch only from a submitter with a bond of at least 1,000 QOR; pass
 * --bond-qor to add to it first. The bond can be withdrawn a full challenge window after the
 * submitter's last batch. Without --execute nothing is sent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  anchoredBatchMessage,
  bondSubmitterMessage,
  loadAccount,
  loadDeployment,
  NativeSender,
  planSettlement,
  settlementReceipt,
  testnet,
  verifyReceipt,
} from "@augury/chain";
import { RestClient } from "@qorechain/rdk";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    deployment: { type: "string", default: "deployments/testnet.json" },
    "bond-qor": { type: "string" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account) {
  console.log("usage: settle.ts --account secrets/sequencer.json [--bond-qor 1000] [--execute]");
  process.exit(1);
}

const net = testnet();
const deployment = loadDeployment(values.deployment);
const account = await loadAccount(values.account);
const rest = new RestClient(net.rest);
const rollupId = deployment.rollupId;

const [bond, params, inbox] = await Promise.all([
  rest.getSubmitterBond(rollupId, account.cosmos),
  rest.getParams(),
  rest.getInbox(rollupId),
]);
console.log(`rollup ${rollupId}: inbox consumed ${inbox.consumedSequence} of ${inbox.headSequence}`);
console.log(`submitter bond: ${bond.amount} uqor (minimum ${params.minSubmitterBond ?? "1000000000"})`);

const native = values.execute ? await NativeSender.connect(net, account) : undefined;

if (values["bond-qor"]) {
  const amount = BigInt(values["bond-qor"]) * 1_000_000n;
  if (!native) {
    console.log(`would bond ${values["bond-qor"]} QOR (dry run)`);
  } else {
    const tx = await native.send([bondSubmitterMessage(account.cosmos, rollupId, amount)]);
    console.log(`bonded ${values["bond-qor"]} QOR (tx ${tx.hash})`);
  }
}

let plan;
try {
  plan = await planSettlement(rest, { chainId: net.chainId, rollupId, submitter: account.cosmos });
} catch (err) {
  console.log(`no batch can be settled now: ${err instanceof Error ? err.message : String(err)}`);
  native?.disconnect();
  process.exit(values.execute ? 1 : 0);
}
const batchIndex = Number(plan.input.batchIndex);
console.log(`batch ${batchIndex}: inbox up to ${plan.input.inboxEnd}, ${plan.entries.length} entries, ${plan.input.txCount} qledger txs`);
if (!native) {
  console.log("dry run: nothing was sent. Add --execute to submit the anchored batch.");
  process.exit(0);
}

const tx = await native.send([anchoredBatchMessage(plan, account, net.chainId)]);
native.disconnect();
console.log(`anchored batch ${batchIndex} submitted (tx ${tx.hash})`);

const receipt = await settlementReceipt(rollupId, batchIndex);
const check = await verifyReceipt(receipt);
console.log(`receipt verification: ${check.valid ? "VALID" : "INVALID"} (${check.mode}) ${JSON.stringify(check.checks)}`);
if (check.reason) console.log(`reason: ${check.reason}`);

mkdirSync("receipts", { recursive: true });
const file = `receipts/${rollupId}-${batchIndex}.json`;
writeFileSync(file, `${JSON.stringify({ receipt, verification: { valid: check.valid, mode: check.mode, checks: check.checks } }, null, 2)}\n`);
console.log(`saved ${file}`);
if (!check.valid) {
  // Never record an invalid receipt as evidence: fail so it cannot be mistaken for success.
  console.log("the receipt did NOT verify; do not cite it in EVIDENCE.md");
  process.exit(1);
}
