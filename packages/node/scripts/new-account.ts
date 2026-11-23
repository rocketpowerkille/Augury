/**
 * Create a new account for one Augury role and save its mnemonic to secrets/<role>.json.
 *
 *   node packages/node/scripts/new-account.ts <role>
 *
 * secrets/ is git-ignored. The mnemonic is written to the file only, never printed. The
 * script refuses to overwrite an existing file.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveUnifiedAccount, generateMnemonic } from "@qorechain/sdk";

const role = process.argv[2];
if (!role || !/^[a-z0-9-]+$/.test(role)) {
  console.log("usage: new-account.ts <role>   (e.g. sequencer, committee-0, reporter-1, watchtower)");
  process.exit(1);
}

const dir = "secrets";
const file = join(dir, `${role}.json`);
if (existsSync(file)) {
  console.error(`${file} already exists; refusing to overwrite it`);
  process.exit(1);
}

const mnemonic = generateMnemonic(256);
const account = await deriveUnifiedAccount(mnemonic);
mkdirSync(dir, { recursive: true });
writeFileSync(file, `${JSON.stringify({ mnemonic }, null, 2)}\n`, { mode: 0o600 });

console.log(`saved ${file} (keep it secret; it is git-ignored)`);
console.log(`native address: ${account.cosmos}`);
console.log(`EVM address:    ${account.evm}`);
console.log("next: fund it with test QOR from the faucet, then run setup-account.ts");
