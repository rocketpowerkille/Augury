import { readFileSync } from "node:fs";
import type { Hex } from "@augury/shared";
import { deriveUnifiedAccount, validateMnemonic, type UnifiedAccount } from "@qorechain/sdk";

/**
 * Accounts are unified eth_secp256k1 identities: one key gives the same 20-byte account on
 * the native lane (`qor1…`) and the EVM lane (`0x…`), plus the ML-DSA-87 key pair that
 * signs hybrid transactions and Augury messages.
 *
 * Secrets live in git-ignored files (`secrets/<role>.json`, see .gitignore). This module
 * never logs or returns them in error messages.
 */

export interface AccountFile {
  mnemonic: string;
}

export async function loadAccount(path: string): Promise<UnifiedAccount> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`could not read account file ${path}`);
  }
  const mnemonic = (parsed as Partial<AccountFile> | null)?.mnemonic;
  if (typeof mnemonic !== "string" || !validateMnemonic(mnemonic)) {
    throw new Error(`account file ${path} does not hold a valid mnemonic`);
  }
  return deriveUnifiedAccount(mnemonic);
}

/** The account's EVM address, lowercase. */
export function evmAddress(account: UnifiedAccount): Hex {
  return account.evm.toLowerCase() as Hex;
}
