/**
 * Read-only check that QoreChain's pqcVerify precompile accepts ML-DSA-87 signatures made
 * with @qorechain/pqc, the library Augury signs with. It only sends eth_call requests:
 * no transaction, no stored keys, no funds. The key it signs with is thrown away.
 *
 *   node scripts/check-precompile.ts [rpcUrl]
 */
import { randomBytes } from "node:crypto";
import { bytesToHex, encodeUint, concatBytes, generateSigningKey } from "../src/index.ts";
import { mldsa87 } from "@qorechain/pqc";

const RPC = process.argv[2] ?? "https://evm-testnet.qore.host";
const PQC_VERIFY = "0x0000000000000000000000000000000000000a01";
// keccak256("pqcVerify(bytes,bytes,bytes)")[0:4], from `cast sig`
const SELECTOR = "0xf52bde0a";

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** abi.encode(bytes, bytes, bytes) */
function encodeBytesArgs(...items: Uint8Array[]): Uint8Array {
  const pad = (b: Uint8Array) => concatBytes(b, new Uint8Array((32 - (b.length % 32)) % 32));
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = 32 * items.length;
  for (const item of items) {
    heads.push(encodeUint(offset));
    const tail = concatBytes(encodeUint(item.length), pad(item));
    tails.push(tail);
    offset += tail.length;
  }
  return concatBytes(...heads, ...tails);
}

async function verifyOnChain(pk: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<string> {
  const data = bytesToHex(encodeBytesArgs(pk, sig, msg)).slice(2);
  return (await rpc("eth_call", [{ to: PQC_VERIFY, data: SELECTOR + data }, "latest"])) as string;
}

const chainId = BigInt((await rpc("eth_chainId", [])) as string);
console.log(`RPC ${RPC}, chain id ${chainId}`);

const key = generateSigningKey();
const message = new Uint8Array(randomBytes(256));
const signature = mldsa87.sign(key.secretKey, message);

const good = await verifyOnChain(key.publicKey, signature, message);
const tampered = Uint8Array.from(message);
tampered[0] = tampered[0]! ^ 1;
const bad = await verifyOnChain(key.publicKey, signature, tampered);

const callData = SELECTOR + bytesToHex(encodeBytesArgs(key.publicKey, signature, message)).slice(2);
const gas = BigInt((await rpc("eth_estimateGas", [{ to: PQC_VERIFY, data: callData }])) as string);
console.log(`gas for one pqcVerify call (incl. 21000 base + calldata): ${gas}`);

const asBool = (ret: string) => (ret === "0x" ? "no answer (precompile inactive?)" : BigInt(ret) === 1n ? "valid" : "invalid");
console.log(`valid signature    -> ${asBool(good)}`);
console.log(`tampered message   -> ${asBool(bad)}`);
const ok = asBool(good) === "valid" && asBool(bad) === "invalid";
console.log(ok ? "OK: the precompile verifies @qorechain/pqc ML-DSA-87 signatures" : "MISMATCH");
process.exitCode = ok ? 0 : 1;
