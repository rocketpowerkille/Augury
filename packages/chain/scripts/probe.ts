/**
 * Read-only probe of the chain adapters against the testnet. It reads public state only:
 * no transaction, no keys, no funds.
 *
 *   node scripts/probe.ts [rollupId]
 *
 * By default it reads `vigil-pay-1`, a public rollup another fest team runs, to exercise
 * the inbox reader on real posts (which are not Augury posts and should all be skipped).
 */
import { RestClient } from "@qorechain/rdk";
import { pqcKeyStatus } from "@qorechain/evm";
import { InboxReader, publicClient, testnet } from "../src/index.ts";

const net = testnet();
const rollupId = process.argv[2] ?? "vigil-pay-1";

const rollup = await new RestClient(net.rest).getRollup(rollupId);
console.log(`rollup ${rollupId}: status ${rollup.status}, execution ${rollup.executionVm}, sequencing ${rollup.sequencing}`);

const reader = new InboxReader({ rest: net.rest, chainId: net.chainId, rollupId });
const head = await reader.head();
console.log(`inbox head: ${head}`);

const from = head > 3n ? head - 3n : 0n;
const entries = await reader.read(from, head);
console.log(`read posts ${from + 1n}..${head}, verified against the chain's accumulator; Augury posts among them: ${entries.length}`);

const client = publicClient(net);
console.log(`EVM block: ${await client.getBlockNumber()}`);
const status = await pqcKeyStatus(client, "0x0000000000000000000000000000000000000001");
console.log(`pqcKeyStatus(0x…01): registered=${status.registered}`);
