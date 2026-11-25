/**
 * The Augury node.
 *
 *   node packages/node/src/cli.ts <role> --account <file> [options]
 *
 * Roles: committee, reporter, sequencer, watchtower. The account file holds the role's
 * mnemonic and must stay out of git (secrets/ is git-ignored).
 */
import { parseArgs } from "node:util";
import { loadAccount } from "@augury/chain";
import { FEEDS, type Hex } from "@augury/shared";
import { runCommittee } from "./roles/committee.ts";
import { REPORTABLE_FEEDS, runReporter } from "./roles/reporter.ts";
import { runSequencer } from "./roles/sequencer.ts";
import { runWatchtower } from "./roles/watchtower.ts";
import { createContext } from "./runtime.ts";
import type { FeedName } from "@augury/reporter";

const USAGE = `usage: augury <committee|reporter|sequencer|watchtower> --account <file> [options]

options:
  --deployment <file>    deployment file (default deployments/testnet.json)
  --feeds <list>         comma-separated feeds (default fBTC/USD,fETH/USD)
  --round-blocks <n>     committee: blocks a round stays open (default 60)
  --margin-blocks <n>    reporter: blocks kept before a round closes (default 5)
  --from-block <n>       watchtower: EVM block to watch from (default: 5000 blocks back)
  --state <dir>          reporter: where signed reports are kept across restarts (default state)
  --interval <ms>        time between ticks (default 5000)
  --once                 run a single tick and exit`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    account: { type: "string" },
    deployment: { type: "string", default: "deployments/testnet.json" },
    feeds: { type: "string", default: "fBTC/USD,fETH/USD" },
    "round-blocks": { type: "string", default: "60" },
    "margin-blocks": { type: "string", default: "5" },
    "from-block": { type: "string" },
    state: { type: "string", default: "state" },
    interval: { type: "string", default: "5000" },
    once: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const role = positionals[0];
if (values.help || !role || !values.account) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const feedNames = values.feeds.split(",").map((f) => f.trim()) as FeedName[];
for (const name of feedNames) {
  if (!(name in FEEDS)) throw new Error(`unknown feed ${name}`);
}
const feedIds: Hex[] = feedNames.map((name) => FEEDS[name]);
const loop = { intervalMs: Number(values.interval), once: values.once };

const ctx = createContext(values.deployment, role);
const account = await loadAccount(values.account);

switch (role) {
  case "committee":
    await runCommittee(ctx, { account, feeds: feedIds, roundBlocks: BigInt(values["round-blocks"]), ...loop });
    break;
  case "reporter": {
    const unsupported = feedNames.filter((f) => !REPORTABLE_FEEDS.includes(f));
    if (unsupported.length > 0) throw new Error(`no price source yet for ${unsupported.join(", ")}`);
    await runReporter(ctx, { account, feeds: feedNames, marginBlocks: BigInt(values["margin-blocks"]), stateDir: values.state, ...loop });
    break;
  }
  case "sequencer":
    await runSequencer(ctx, { account, feeds: feedIds, ...loop });
    break;
  case "watchtower": {
    const head = await ctx.evm.getBlockNumber();
    const fromBlock = values["from-block"] !== undefined ? BigInt(values["from-block"]) : head > 5000n ? head - 5000n : 0n;
    await runWatchtower(ctx, { account, fromBlock, ...loop });
    break;
  }
  default:
    console.log(USAGE);
    process.exit(1);
}
