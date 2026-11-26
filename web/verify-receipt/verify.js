// Verify a QoreChain RDK settlement receipt from a browser, with no libraries.
//
// The page calls Augury's SettlementReceipts contract on the QoreChain EVM with `eth_call`.
// The contract rebuilds the receipt's canonical v2 anchor message, resolves the rollup
// creator's ML-DSA-87 key with the pqcKeyStatus precompile and checks the signature with the
// pqcVerify precompile. So the browser trusts no key from the receipt itself.
//
// What this does not check: that QoreChain recorded the anchor. That lives in the chain's
// native state, whose REST API does not allow browser requests; `settle.ts` checks it.
//
// The same module is imported by packages/chain/test/web.test.ts, which checks the calldata
// against viem's encoder and the selector against the contract's ABI.

/** `verifyAnchor((string,string,uint64,bytes,bytes,uint64,bytes),address,bytes)` */
export const VERIFY_ANCHOR_SELECTOR = "ebd47c84";

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

/** The 0x address of a `qor1…` account (a checked bech32 decode). */
export function qorToEvm(address) {
  const addr = address.toLowerCase();
  const sep = addr.lastIndexOf("1");
  const hrp = addr.slice(0, sep);
  const data = [...addr.slice(sep + 1)].map((c) => {
    const v = BECH32.indexOf(c);
    if (v < 0) throw new Error(`not a bech32 character: ${c}`);
    return v;
  });
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...expanded, ...data]) !== 1) throw new Error("bad bech32 checksum");
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 20) throw new Error("not a 20-byte account address");
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const strip = (hex) => (hex ?? "").replace(/^0x/, "").toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
const utf8Hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** ABI encoding of a dynamic `bytes` value (given as hex): length, then the padded data. */
const dynamic = (hex) => word(hex.length / 2) + pad(hex);

/** Calldata for `SettlementReceipts.verifyAnchor` from a v2 receipt (the JSON the RDK builds). */
export function verifyAnchorCalldata(receipt) {
  if (receipt.version !== 2 || !receipt.chainId || receipt.transactionCount === undefined) {
    throw new Error("only version-2 receipts can be checked (v1 anchors carry no chain id)");
  }
  // The anchor tuple: three static words, four dynamic fields (offsets from the tuple start).
  const tails = [
    dynamic(utf8Hex(receipt.chainId)),
    dynamic(utf8Hex(receipt.layerId)),
    dynamic(strip(receipt.stateRoot)),
    dynamic(strip(receipt.validatorSetHash)),
    dynamic(strip(receipt.compressedStateProof)),
  ];
  const offsets = [];
  let at = 7 * 32;
  for (const t of tails) {
    offsets.push(at);
    at += t.length / 2;
  }
  const tuple =
    word(offsets[0]) +
    word(offsets[1]) +
    word(receipt.batchIndex) +
    word(offsets[2]) +
    word(offsets[3]) +
    word(receipt.transactionCount) +
    word(offsets[4]) +
    tails.join("");
  const creator = strip(qorToEvm(receipt.creator)).padStart(64, "0");
  const signature = dynamic(strip(receipt.pqcSignature));
  const head = word(3 * 32) + creator + word(3 * 32 + tuple.length / 2);
  return `0x${VERIFY_ANCHOR_SELECTOR}${head}${tuple}${signature}`;
}

/** Ask the SettlementReceipts contract at `verifier` whether the receipt's anchor signature checks out. */
export async function verifyInBrowser(receipt, { rpc, verifier }) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: verifier, data: verifyAnchorCalldata(receipt) }, "latest"],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "eth_call failed");
  return BigInt(body.result) === 1n;
}
