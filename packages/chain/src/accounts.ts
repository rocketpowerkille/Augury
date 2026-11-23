import { readFileSync } from "node:fs";
import { hexToBytes, type Hex } from "@augury/shared";
import {
  AlgorithmDilithium5,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  signProofOfPossession,
  validateMnemonic,
  type UnifiedAccount,
} from "@qorechain/sdk";
import type { NativeMessage } from "./native.ts";

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

/**
 * `MsgRegisterPQCKeyV2` registering the account's ML-DSA-87 key, with the key's proof of
 * possession, so the chain knows the account holds the secret half.
 */
export function pqcRegistrationMessage(account: UnifiedAccount, chainId: string): NativeMessage {
  return buildRegisterPqcKeyMsg(account.cosmos, {
    pqcKeypair: account.pqc,
    ecdsaPubkey: hexToBytes(account.publicKey),
    proofOfPossession: signProofOfPossession({
      chainId,
      account: account.cosmos,
      keypair: account.pqc,
      algorithmId: AlgorithmDilithium5,
    }),
  });
}

/** The account's EVM address, lowercase. */
export function evmAddress(account: UnifiedAccount): Hex {
  return account.evm.toLowerCase() as Hex;
}
