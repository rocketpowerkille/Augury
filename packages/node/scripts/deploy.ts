/**
 * Deploy Augury on the testnet: create the rollup, deploy AuguryHub, bond the sequencer and
 * write deployments/testnet.json. The deploying account becomes the sequencer and the rollup's
 * creator (its ML-DSA-87 key anchors rollup batches).
 *
 *   node packages/node/scripts/deploy.ts --account secrets/sequencer.json \
 *     --committee 0x…,0x…,0x… [--rollup-id augury-oracle] [--execute]
 *
 * Without --execute it checks everything and prints the plan, sending nothing.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  bondSequencerCalldata,
  createRollupMessage,
  deployAuguryHub,
  fetchKemKeys,
  HubSender,
  loadAccount,
  MIN_ROLLUP_STAKE_UQOR,
  NativeSender,
  publicClient,
  testnet,
  type Deployment,
  type HubParams,
} from "@augury/chain";
import { ML_DSA_87_ALGORITHM_ID, type Hex } from "@augury/shared";
import { pqcKeyStatus } from "@qorechain/evm";
import { isRestNotFound, RestClient } from "@qorechain/rdk";

const QOR = 10n ** 18n; // wei per QOR on the EVM lane

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    committee: { type: "string" },
    "rollup-id": { type: "string", default: "augury-oracle" },
    "rollup-stake-qor": { type: "string", default: "10000" },
    "reporter-stake-qor": { type: "string", default: "1" },
    "sequencer-bond-qor": { type: "string", default: "10" },
    "challenge-window": { type: "string", default: "3600" },
    "exit-delay": { type: "string", default: "7200" },
    "activity-grace": { type: "string", default: "600" },
    "min-reports": { type: "string", default: "3" },
    "max-reports": { type: "string", default: "16" },
    out: { type: "string", default: "deployments/testnet.json" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account || !values.committee) {
  console.log("usage: deploy.ts --account secrets/sequencer.json --committee 0x…,0x…,0x… [--execute]");
  process.exit(1);
}

const net = testnet();
const client = publicClient(net);
const account = await loadAccount(values.account);
const sequencer = account.evm.toLowerCase() as Hex;
const committee = values.committee.split(",").map((a) => a.trim().toLowerCase()) as Hex[];
if (committee.length !== 3 || committee.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) {
  throw new Error("--committee must list three 0x addresses");
}
if (existsSync(values.out)) throw new Error(`${values.out} already exists; move it away to redeploy`);

const params: HubParams = {
  sequencer,
  mldsaAlgorithmId: ML_DSA_87_ALGORITHM_ID,
  minReporterStake: BigInt(values["reporter-stake-qor"]) * QOR,
  minSequencerBond: BigInt(values["sequencer-bond-qor"]) * QOR,
  challengeWindow: BigInt(values["challenge-window"]),
  exitDelay: BigInt(values["exit-delay"]),
  activityGrace: BigInt(values["activity-grace"]),
  minReports: Number(values["min-reports"]),
  maxReports: Number(values["max-reports"]),
};
const rollupId = values["rollup-id"];
const rollupStake = BigInt(values["rollup-stake-qor"]) * 1_000_000n;

// --- Checks (read-only) ----------------------------------------------------------------
const problems: string[] = [];
const status = await pqcKeyStatus(client, sequencer);
if (!status.registered) problems.push(`sequencer ${sequencer} has no ML-DSA-87 key; run setup-account.ts first`);
for (const member of committee) {
  try {
    await fetchKemKeys(net.rest, [member]);
  } catch {
    problems.push(`committee member ${member} has no ML-KEM key; run setup-account.ts --kem for it`);
  }
}
const rest = new RestClient(net.rest);
let rollupExists = false;
try {
  await rest.getRollup(rollupId);
  rollupExists = true;
} catch (err) {
  if (!isRestNotFound(err)) throw err;
}
const balanceUqor = (await client.getBalance({ address: sequencer })) / 10n ** 12n;
const needed = (rollupExists ? 0n : rollupStake) + params.minSequencerBond / 10n ** 12n;
if (balanceUqor < needed) problems.push(`sequencer has ${balanceUqor} uqor, needs about ${needed} uqor plus fees`);
if (!rollupExists && rollupStake < MIN_ROLLUP_STAKE_UQOR) problems.push("rollup stake is below the chain minimum");

console.log(`network:   ${net.chainId} (EVM ${net.evmChainId})`);
console.log(`sequencer: ${account.cosmos} / ${sequencer}`);
console.log(`committee: ${committee.join(", ")}`);
console.log(`rollup:    ${rollupId} ${rollupExists ? "(exists, will reuse)" : `(will create with ${rollupStake} uqor stake, 1% burned)`}`);
console.log(`hub:       ${JSON.stringify(params, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);
for (const p of problems) console.log(`PROBLEM: ${p}`);
if (problems.length > 0) process.exit(1);
if (!values.execute) {
  console.log("dry run: all checks passed, nothing was sent. Add --execute to deploy.");
  process.exit(0);
}

// --- Deployment ------------------------------------------------------------------------
const native = await NativeSender.connect(net, account);
if (!rollupExists) {
  const tx = await native.send([createRollupMessage(account.cosmos, rollupId, rollupStake)]);
  console.log(`rollup created (tx ${tx.hash})`);
}

const hub = await deployAuguryHub({ net, account, native, params });
console.log(`AuguryHub deployed at ${hub.address} (tx ${hub.txHash})`);

const deployment: Deployment = {
  network: "testnet",
  hub: hub.address,
  rollupId,
  committee: [committee[0]!, committee[1]!, committee[2]!],
  sequencer,
  minReports: params.minReports,
  maxReports: params.maxReports,
};
mkdirSync("deployments", { recursive: true });
writeFileSync(values.out, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`wrote ${values.out}`);

const bond = await new HubSender({ net, hub: hub.address, account, native }).send(bondSequencerCalldata(), params.minSequencerBond);
console.log(`sequencer bonded ${values["sequencer-bond-qor"]} QOR (tx ${bond.hash}, ${bond.status})`);
native.disconnect();
console.log("done. Record the transaction hashes above in EVIDENCE.md.");
