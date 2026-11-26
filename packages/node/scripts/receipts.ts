/**
 * Verify settlement receipts in Solidity on the testnet, and record them.
 *
 *   node packages/node/scripts/receipts.ts --account secrets/<any>.json \
 *     --receipt packages/chain/test/fixtures/receipt-cloister-dev-1-1.json [--receipt …] [--execute]
 *
 * Without --execute, each receipt is checked by running SettlementReceipts in a deployless
 * eth_call against the real pqcKeyStatus and pqcVerify precompiles; nothing is sent. With
 * --execute, the contract is deployed once (deployments/testnet-receipts.json), each receipt
 * is recorded on chain, and then checked again through the browser verifier's own code
 * (web/verify-receipt/verify.js) against the deployed contract.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  deployThroughWindow,
  HubSender,
  loadAccount,
  NativeSender,
  publicClient,
  recordReceiptCalldata,
  settlementReceiptsAbi,
  settlementReceiptsBytecode,
  testnet,
  verifyReceiptOnEvm,
} from "@augury/chain";
import { ML_DSA_87_ALGORITHM_ID, type Hex } from "@augury/shared";
import type { SettlementReceipt } from "@qorechain/rdk";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    receipt: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "deployments/testnet-receipts.json" },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account || values.receipt.length === 0) {
  console.log("usage: receipts.ts --account <file> --receipt <receipt.json> [--receipt …] [--execute]");
  process.exit(1);
}

const net = testnet();
const client = publicClient(net);
const receipts = values.receipt.map((f) => ({ file: f, receipt: JSON.parse(readFileSync(f, "utf8")) as SettlementReceipt }));

for (const { file, receipt } of receipts) {
  const ok = await verifyReceiptOnEvm(client, receipt);
  console.log(`${file}: ${receipt.layerId} batch ${receipt.batchIndex}, deployless verifyAnchor = ${ok}`);
  if (!ok) throw new Error(`${file} does not verify; refusing to continue`);
}
if (!values.execute) {
  console.log("dry run: nothing was sent. Add --execute to deploy the verifier and record the receipts.");
  process.exit(0);
}

const account = await loadAccount(values.account);
const native = await NativeSender.connect(net, account);
let verifier: Hex;
if (existsSync(values.out)) {
  verifier = (JSON.parse(readFileSync(values.out, "utf8")) as { verifier: Hex }).verifier;
} else {
  const deployed = await deployThroughWindow({
    net,
    account,
    native,
    label: "SettlementReceipts",
    abi: settlementReceiptsAbi,
    bytecode: settlementReceiptsBytecode,
    args: [ML_DSA_87_ALGORITHM_ID],
  });
  verifier = deployed.address;
  writeFileSync(values.out, `${JSON.stringify({ network: "testnet", verifier, deployTx: deployed.txHash }, null, 2)}\n`);
  console.log(`SettlementReceipts deployed at ${verifier} (tx ${deployed.txHash}); wrote ${values.out}`);
}

const sender = new HubSender({ net, hub: verifier, account, native });
const web = (await import(new URL("../../../web/verify-receipt/verify.js", import.meta.url).href)) as {
  verifyInBrowser(r: SettlementReceipt, o: { rpc: string; verifier: string }): Promise<boolean>;
};
for (const { file, receipt } of receipts) {
  const tx = await sender.send(recordReceiptCalldata(receipt));
  console.log(`${file}: recorded on chain (tx ${tx.hash}, ${tx.status})`);
  const viaBrowserCode = await web.verifyInBrowser(receipt, { rpc: net.evmRpc, verifier });
  console.log(`${file}: browser verifier against ${verifier} = ${viaBrowserCode}`);
}
native.disconnect();
