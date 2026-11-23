/**
 * Prepare an account for its role on the testnet: register its ML-DSA-87 key (with a proof
 * of possession) and, for committee members, publish its ML-KEM-1024 key in the chain's KEM
 * registry. Already-done steps are skipped.
 *
 *   node packages/node/scripts/setup-account.ts --account secrets/<role>.json [--kem] [--execute]
 *
 * Without --execute it only reports what it would do.
 */
import { parseArgs } from "node:util";
import {
  fetchKemKeys,
  loadAccount,
  NativeSender,
  pqcRegistrationMessage,
  publicClient,
  registerKemKeyMessage,
  testnet,
} from "@augury/chain";
import { bytesEqual, type Hex } from "@augury/shared";
import { pqcKeyStatus } from "@qorechain/evm";
import { deriveSealKeys } from "@qorechain/qoreseal";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    kem: { type: "boolean", default: false },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account) {
  console.log("usage: setup-account.ts --account secrets/<role>.json [--kem] [--execute]");
  process.exit(1);
}

const net = testnet();
const account = await loadAccount(values.account);
const evm = account.evm as Hex;
console.log(`account ${account.cosmos} / ${evm}`);

const balance = await publicClient(net).getBalance({ address: evm });
console.log(`balance: ${balance / 10n ** 12n} uqor`);
if (balance === 0n) {
  console.log("the account has no QOR; fund it from the faucet first");
  process.exit(1);
}

// 1. ML-DSA-87 key.
const status = await pqcKeyStatus(publicClient(net), evm);
if (status.registered) {
  console.log(`ML-DSA-87 key: already registered (algorithm ${status.algorithmId})`);
} else if (!values.execute) {
  console.log("ML-DSA-87 key: would register it (dry run)");
} else {
  // The registration is the one transaction signed classically: the key is not on chain yet.
  const native = await NativeSender.connect(net, account, { signMode: "classical" });
  const tx = await native.send([pqcRegistrationMessage(account, net.chainId)]);
  native.disconnect();
  console.log(`ML-DSA-87 key: registered (tx ${tx.hash})`);
}

// 2. ML-KEM-1024 key, for committee members.
if (values.kem) {
  if (!account.mnemonic) throw new Error("committee accounts must come from a mnemonic");
  const sealKeys = deriveSealKeys({ mnemonic: account.mnemonic });
  let registered: Uint8Array | undefined;
  try {
    [registered] = await fetchKemKeys(net.rest, [evm]);
  } catch {
    registered = undefined;
  }
  if (registered && bytesEqual(registered, sealKeys.mlkemPublicKey)) {
    console.log("ML-KEM-1024 key: already published");
  } else if (registered) {
    console.log("ML-KEM-1024 key: a different key is published; replace it by hand if intended");
  } else if (!values.execute) {
    console.log("ML-KEM-1024 key: would publish it (dry run)");
  } else {
    const native = await NativeSender.connect(net, account);
    const tx = await native.send([registerKemKeyMessage(account.cosmos, sealKeys.mlkemPublicKey)]);
    native.disconnect();
    console.log(`ML-KEM-1024 key: published (tx ${tx.hash})`);
  }
}

if (!values.execute) console.log("dry run: nothing was sent. Add --execute to send.");
