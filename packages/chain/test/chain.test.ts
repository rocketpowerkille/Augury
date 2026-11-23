import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodePost, FEEDS, type SignedReport } from "@augury/shared";
import { deriveUnifiedAccount, evmToQor, qorechainRegistry, verifyProofOfPossession } from "@qorechain/sdk";
import { openEvmWindowMessage } from "@qorechain/evm";
import {
  auguryRegistry,
  challengeBatchCalldata,
  createRollupMessage,
  feeFor,
  gasFor,
  inboxPostMessage,
  parseAccountSequence,
  parseDeployment,
  postBatchCalldata,
  pqcRegistrationMessage,
  registerKemKeyMessage,
  stakeCalldata,
  testnet,
  toInboxEntries,
} from "../src/index.ts";

const FEED = FEEDS["fBTC/USD"];
const report: SignedReport = {
  feedId: FEED,
  round: 42n,
  reporter: "0x2222222222222222222222222222222222222222",
  price: 9712345000000n,
  observedAt: 1764000000n,
  salt: `0x${"77".repeat(32)}`,
  signature: Uint8Array.of(0xab, 0xcd),
};

describe("network and deployment", () => {
  it("uses the official testnet preset", () => {
    const net = testnet();
    assert.equal(net.chainId, "qorechain-diana");
    assert.equal(net.evmChainId, 9800n);
    assert.match(net.evmRpc, /^https:\/\//);
  });

  const valid = {
    network: "testnet",
    hub: "0x1111111111111111111111111111111111111111",
    rollupId: "augury-oracle",
    committee: ["0x00000000000000000000000000000000000000c0", "0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000c2"],
    sequencer: "0x00000000000000000000000000000000000000AA",
    minReports: 3,
    maxReports: 16,
  };

  it("parses a deployment and lowercases addresses", () => {
    const d = parseDeployment(valid);
    assert.equal(d.sequencer, "0x00000000000000000000000000000000000000aa");
    assert.equal(d.committee.length, 3);
  });

  it("rejects a malformed deployment", () => {
    assert.throws(() => parseDeployment({ ...valid, hub: "0x12" }), /hub/);
    assert.throws(() => parseDeployment({ ...valid, committee: valid.committee.slice(0, 2) }), /committee/);
    assert.throws(() => parseDeployment({ ...valid, maxReports: 2 }), /maxReports/);
  });
});

describe("accounts", () => {
  // A well-known BIP-39 test mnemonic: never use it for anything real.
  const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("builds a PQC key registration whose proof of possession verifies", async () => {
    const account = await deriveUnifiedAccount(TEST_MNEMONIC);
    const msg = pqcRegistrationMessage(account, "qorechain-diana");
    const registry = auguryRegistry();
    const decoded = registry.decode(registry.encodeAsAny(msg)) as {
      sender: string;
      algorithmId: number;
      dilithiumPubkey: Uint8Array;
      proofOfPossession: Uint8Array;
    };
    assert.equal(decoded.sender, account.cosmos);
    assert.equal(decoded.algorithmId, 1);
    assert.equal(
      verifyProofOfPossession({
        chainId: "qorechain-diana",
        account: account.cosmos,
        publicKey: account.pqc.publicKey,
        algorithmId: 1,
        proof: decoded.proofOfPossession,
      }),
      true,
    );
    assert.equal(
      verifyProofOfPossession({
        chainId: "qorechain-vladi",
        account: account.cosmos,
        publicKey: account.pqc.publicKey,
        algorithmId: 1,
        proof: decoded.proofOfPossession,
      }),
      false,
    );
  });
});

describe("native transactions", () => {
  it("reads account number and sequence, plain or nested", () => {
    assert.deepEqual(parseAccountSequence({ account: { account_number: "7", sequence: "3" } }), {
      accountNumber: 7n,
      sequence: 3n,
    });
    assert.deepEqual(parseAccountSequence({ account: { base_account: { account_number: "9", sequence: "0" } } }), {
      accountNumber: 9n,
      sequence: 0n,
    });
    assert.throws(() => parseAccountSequence({}));
  });

  it("sizes gas from the encoded messages", () => {
    const poster = evmToQor("0x2222222222222222222222222222222222222222");
    const small = inboxPostMessage(poster, "augury-oracle", { kind: "report", feedId: FEED, round: 1n, envelope: "0x00" });
    const large = inboxPostMessage(poster, "augury-oracle", {
      kind: "report",
      feedId: FEED,
      round: 1n,
      envelope: `0x${"ab".repeat(5000)}`,
    });
    assert.ok(gasFor([small]) >= 360_000n);
    assert.ok(gasFor([large]) > gasFor([small]) + 20n * 4_900n);
  });

  it("rounds fees up", () => {
    assert.equal(feeFor(200_000n, "0.025"), 5_000n);
    assert.equal(feeFor(3n, "0.5"), 2n);
    assert.equal(feeFor(10n, "2"), 20n);
  });
});

describe("rollup inbox", () => {
  const open = { kind: "report", feedId: FEED, round: 1n, envelope: "0xdeadbeef" } as const;
  const poster = evmToQor("0x2222222222222222222222222222222222222222");

  it("turns raw entries into Augury entries, skipping deposits and foreign payloads", () => {
    const entries = toInboxEntries(
      [
        { height: 10n, poster, payload: encodePost(open) },
        { height: 11n, poster: "deposit:qor1xyz", payload: new Uint8Array(8) },
        { height: 12, poster, payload: new TextEncoder().encode("not augury") },
        { height: 13n, poster, payload: encodePost(open) },
      ],
      100n,
    );
    assert.deepEqual(
      entries.map((e) => [e.seq, e.height, e.poster]),
      [
        [101n, 10n, "0x2222222222222222222222222222222222222222"],
        [104n, 13n, "0x2222222222222222222222222222222222222222"],
      ],
    );
    assert.deepEqual(entries[0]!.post, open);
  });

  it("the SDK's default registry cannot encode inbox posts (why auguryRegistry exists)", () => {
    const msg = inboxPostMessage(poster, "augury-oracle", open);
    assert.throws(() => qorechainRegistry().encodeAsAny(msg), /Unregistered type url/);
  });

  it("builds a post message the Augury registry can encode", () => {
    const msg = inboxPostMessage(poster, "augury-oracle", open);
    const registry = auguryRegistry();
    const any = registry.encodeAsAny(msg);
    assert.equal(any.typeUrl, "/qorechain.rdk.v1.MsgPostRollupData");
    const decoded = registry.decode(any) as { poster: string; rollupId: string; data: Uint8Array };
    assert.equal(decoded.poster, poster);
    assert.equal(decoded.rollupId, "augury-oracle");
    assert.deepEqual(decoded.data, encodePost(open));
  });

  it("builds a based, qledger-v1 rollup creation and rejects bad input", () => {
    const registry = auguryRegistry();
    const decoded = registry.decode(registry.encodeAsAny(createRollupMessage(poster, "augury-oracle", 10_000_000_000n))) as {
      rollupId: string;
      sequencing: string;
      executionVm: string;
    };
    assert.equal(decoded.rollupId, "augury-oracle");
    assert.equal(decoded.sequencing, "based");
    assert.equal(decoded.executionVm, "qledger-v1");
    assert.throws(() => createRollupMessage(poster, "Augury/Oracle", 10_000_000_000n), /rollup id/);
    assert.throws(() => createRollupMessage(poster, "augury-oracle", 1n), /at least/);
  });

  it("the Augury registry encodes a KEM key registration", () => {
    const key = new Uint8Array(1568).fill(7);
    const registry = auguryRegistry();
    const decoded = registry.decode(registry.encodeAsAny(registerKemKeyMessage(poster, key))) as {
      sender: string;
      publicKey: Uint8Array;
    };
    assert.equal(decoded.sender, poster);
    assert.deepEqual(decoded.publicKey, key);
  });

  it("the Augury registry still encodes the SDK's EVM window message", () => {
    const msg = openEvmWindowMessage({
      sender: poster,
      blocks: 600n,
      maxTxs: 10n,
      maxValue: "1000000",
      allowedTargets: ["0x1111111111111111111111111111111111111111"],
    });
    const registry = auguryRegistry();
    const decoded = registry.decode(registry.encodeAsAny(msg)) as { allowedTargets: string[]; maxTxs: unknown };
    assert.deepEqual(decoded.allowedTargets, ["0x1111111111111111111111111111111111111111"]);
  });
});

describe("AuguryHub calldata matches cast", () => {
  it("postBatch", () => {
    const data = postBatchCalldata({
      header: { feedId: FEED, round: 42n, price: 9712345000000n },
      reports: [report],
      signature: Uint8Array.of(1, 2),
    });
    assert.equal(
      data,
      "0x237f3b5b4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000008d554dfa84000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000008d554dfa8400000000000000000000000000000000000000000000000000000000069248100777777777777777777777777777777777777777777777777777777777777777700000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002abcd00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020102000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("challengeBatch with a negative price", () => {
    const data = challengeBatchCalldata(FEED, 42n, [{ ...report, price: -5n }], "0x5555555555555555555555555555555555555555");
    assert.equal(
      data,
      "0x7ae5388a4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000000800000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000002222222222222222222222222222222222222222fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb0000000000000000000000000000000000000000000000000000000069248100777777777777777777777777777777777777777777777777777777777777777700000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002abcd000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("stake", () => {
    assert.equal(stakeCalldata("0x2222222222222222222222222222222222222222"), "0x264762040000000000000000000000002222222222222222222222222222222222222222");
  });
});
