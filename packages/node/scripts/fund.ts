/**
 * Send test QOR from one account to others, in one hybrid-signed transaction.
 *
 *   node packages/node/scripts/fund.ts --account secrets/sequencer.json \
 *     --to secrets/reporter-0.json=2 --to secrets/committee-0.json=1 [--execute]
 *
 * Each --to is an account file (or a qor1 address) and an amount in QOR.
 */
import { parseArgs } from "node:util";
import { loadAccount, NativeSender, testnet, type NativeMessage } from "@augury/chain";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    to: { type: "string", multiple: true, default: [] },
    execute: { type: "boolean", default: false },
  },
});
if (!values.account || values.to.length === 0) {
  console.log("usage: fund.ts --account secrets/<from>.json --to <file|qor1…>=<QOR> [--to …] [--execute]");
  process.exit(1);
}

const net = testnet();
const from = await loadAccount(values.account);
const transfers: { to: string; label: string; uqor: bigint }[] = [];
for (const spec of values.to) {
  const [target, amount] = spec.split("=");
  if (!target || !amount || !/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error(`bad --to ${spec}`);
  const [whole, frac = ""] = amount.split(".");
  const uqor = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  const to = target.startsWith("qor1") ? target : (await loadAccount(target)).cosmos;
  transfers.push({ to, label: target, uqor });
}

const total = transfers.reduce((n, t) => n + t.uqor, 0n);
console.log(`from ${from.cosmos}`);
for (const t of transfers) console.log(`  ${t.uqor / 1_000_000n}.${String(t.uqor % 1_000_000n).padStart(6, "0")} QOR -> ${t.to} (${t.label})`);
console.log(`total ${total} uqor`);
if (!values.execute) {
  console.log("dry run: nothing was sent. Add --execute to send.");
  process.exit(0);
}

const messages: NativeMessage[] = transfers.map((t) => ({
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: { fromAddress: from.cosmos, toAddress: t.to, amount: [{ denom: "uqor", amount: t.uqor.toString() }] },
}));
const native = await NativeSender.connect(net, from);
const tx = await native.send(messages);
native.disconnect();
console.log(`sent (tx ${tx.hash})`);
