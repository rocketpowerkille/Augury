import { hexToBytes, type Hex } from "@augury/shared";
import { RestClient, registerKemKeyMsg } from "@qorechain/rdk";
import { evmToQor } from "@qorechain/sdk";
import type { NativeMessage } from "./native.ts";

/** ML-KEM-1024's id in the chain's algorithm registry. */
export const ML_KEM_1024_ALGORITHM_ID = 2;

/**
 * The ML-KEM-1024 key each account published in the chain's KEM key registry, in order.
 * Throws if one has none, since nothing could be sealed to it.
 */
export async function fetchKemKeys(rest: string, accounts: readonly Hex[]): Promise<Uint8Array[]> {
  const client = new RestClient(rest);
  return Promise.all(
    accounts.map(async (account) => {
      const view = await client.getKemKey(evmToQor(account));
      if (!view) throw new Error(`${account} has no ML-KEM key in the chain's registry`);
      if (view.algorithmId !== ML_KEM_1024_ALGORITHM_ID) throw new Error(`${account} has a non-ML-KEM-1024 key`);
      return hexToBytes(view.publicKey);
    }),
  );
}

/** The native message that publishes `publicKey` for `sender` (`qor1…`) in the KEM registry. */
export function registerKemKeyMessage(sender: string, publicKey: Uint8Array): NativeMessage {
  return registerKemKeyMsg({ sender, publicKey });
}
