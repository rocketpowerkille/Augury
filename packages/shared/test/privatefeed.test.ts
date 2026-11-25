import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";
import {
  bytesToHex,
  decodePost,
  decodePrivateValue,
  encodePost,
  generateSigningKey,
  MAX_POST_BYTES,
  PRIVATE_TAGS,
  PrivateFeedPublisher,
  PrivateFeedSubscriber,
  privateValueBytes,
  publishMessage,
  valueCommitment,
  type Hex,
  type PrivateDomain,
} from "../src/index.ts";

// Same domain and inputs as contracts/test/PrivateFeeds.t.sol.
const domain: PrivateDomain = { chainId: 9800n, registry: "0x3333333333333333333333333333333333333333" };
const publisher: Hex = "0x2222222222222222222222222222222222222222";
const FEED: Hex = "0xa5f4d8a2fa4fd40c985e13f37c0bb289309b611749bb428d2da09c28a344254e"; // keccak256("nav")
const SALT: Hex = `0x${"77".repeat(32)}`;
const sealChainId = "qorechain-diana";
const signer = generateSigningKey(new Uint8Array(32).fill(3));

function newPublisher() {
  return new PrivateFeedPublisher({ sealChainId, domain, publisher, secretKey: signer.secretKey, feedId: FEED, mode: "mlkem" });
}

function newSubscriber() {
  const keys = generateSealKeys();
  const sub = new PrivateFeedSubscriber({ sealChainId, domain, publisher, feedId: FEED, keys });
  return { sub, recipient: { mlkemPublicKey: recipientOf(keys).mlkemPublicKey } };
}

describe("private feed messages", () => {
  it("match PrivateFeeds.sol byte for byte", () => {
    // Computed independently with Foundry's `cast` and asserted in PrivateFeeds.t.sol too.
    assert.equal(PRIVATE_TAGS.value, "0x7dd7a9c26aeec81055050322d5f5e30a8d5463bf36eca4d80b34d7283b9ebb3a");
    assert.equal(PRIVATE_TAGS.publish, "0x566e0aa9628faf95ff6a7b04f941da865e64d2a162d978ff1da4189df6d8c50b");
    const v = { feedId: FEED, round: 42n, value: 104_250_000_000n, observedAt: 1764000000n, salt: SALT };
    assert.equal(valueCommitment(domain, publisher, v), "0x6334eb2812559d8318ae8e873a377e8ff66f8eaaa95b6c0b67b624ad66d768a1");
    const p = { feedId: FEED, round: 42n, epoch: 1n, commitment: SALT, blobHash: SALT };
    assert.equal(publishMessage(domain, publisher, p).length, 9 * 32);
  });

  it("decodes only canonical value bytes", () => {
    const v = { feedId: FEED, round: 1n, value: -5n, observedAt: 7n, salt: SALT };
    assert.deepEqual(decodePrivateValue(privateValueBytes(v)), v);
    const dirty = privateValueBytes(v);
    dirty[32] = 1; // high byte of the uint64 round word
    assert.throws(() => decodePrivateValue(dirty), /malformed/);
    assert.throws(() => decodePrivateValue(dirty.subarray(1)), /160 bytes/);
  });
});

describe("private feed publishing", () => {
  it("lets a subscriber read a value and check it against the signed commitment", () => {
    const pub = newPublisher();
    const alice = newSubscriber();
    const rotation = pub.addSubscriber("alice", alice.recipient);
    assert.equal(alice.sub.acceptEpochKey(rotation.envelope!), rotation.epoch);

    const out = pub.publish(1n, 104_250_000_000n, 1764000000n);
    const v = alice.sub.open({ blob: out.blob, publication: out.publication, signature: out.signature, publisherKey: signer.publicKey });
    assert.equal(v.value, 104_250_000_000n);
    assert.equal(valueCommitment(domain, publisher, v), out.publication.commitment);
  });

  it("uses a fresh salt, so equal values give unlinkable commitments", () => {
    const pub = newPublisher();
    const a = pub.publish(1n, 100n, 1n);
    const b = pub.publish(2n, 100n, 1n);
    assert.notEqual(a.value.salt, b.value.salt);
    assert.notEqual(a.publication.commitment, b.publication.commitment);
  });

  it("locks out a removed subscriber and keeps earlier values from a new one", () => {
    const pub = newPublisher();
    const alice = newSubscriber();
    const bob = newSubscriber();
    alice.sub.acceptEpochKey(pub.addSubscriber("alice", alice.recipient).envelope!);
    const early = pub.publish(1n, 100n, 1n);

    const rotation = pub.removeSubscriber("alice");
    assert.equal(rotation.envelope, null); // nobody left to send the new key to
    bob.sub.acceptEpochKey(pub.addSubscriber("bob", bob.recipient).envelope!);
    const late = pub.publish(2n, 200n, 2n);

    assert.equal(alice.sub.open({ blob: early.blob, publication: early.publication }).value, 100n);
    assert.throws(() => alice.sub.open({ blob: late.blob, publication: late.publication }));
    assert.equal(bob.sub.open({ blob: late.blob, publication: late.publication }).value, 200n);
    assert.throws(() => bob.sub.open({ blob: early.blob, publication: early.publication }));
  });

  it("rejects an epoch-key envelope sealed to someone else", () => {
    const pub = newPublisher();
    const alice = newSubscriber();
    const eve = newSubscriber();
    const rotation = pub.addSubscriber("alice", alice.recipient);
    assert.throws(() => eve.sub.acceptEpochKey(rotation.envelope!));
  });

  it("rejects tampered publications and blobs", () => {
    const pub = newPublisher();
    const alice = newSubscriber();
    alice.sub.acceptEpochKey(pub.addSubscriber("alice", alice.recipient).envelope!);
    const one = pub.publish(1n, 100n, 1n);
    const two = pub.publish(2n, 200n, 2n);

    // Another commitment, another round's blob, another blob hash, another feed.
    assert.throws(() => alice.sub.open({ blob: one.blob, publication: { ...one.publication, commitment: two.publication.commitment } }), /commitment/);
    assert.throws(() => alice.sub.open({ blob: two.blob, publication: one.publication }), /round|epoch|published/);
    assert.throws(() => alice.sub.open({ blob: one.blob, publication: { ...one.publication, blobHash: two.publication.blobHash } }), /not the one published/);
    assert.throws(() => alice.sub.open({ blob: one.blob, publication: { ...one.publication, feedId: SALT } }), /another feed/);

    // A flipped ciphertext byte fails QoreSeal's authentication.
    const flipped = Uint8Array.from(one.blob);
    flipped[flipped.length - 1]! ^= 1;
    assert.throws(() => alice.sub.open({ blob: flipped, publication: one.publication }));
  });

  it("rejects a signature by another key", () => {
    const pub = newPublisher();
    const alice = newSubscriber();
    alice.sub.acceptEpochKey(pub.addSubscriber("alice", alice.recipient).envelope!);
    const out = pub.publish(1n, 100n, 1n);
    const other = generateSigningKey(new Uint8Array(32).fill(4));
    assert.throws(
      () => alice.sub.open({ blob: out.blob, publication: out.publication, signature: out.signature, publisherKey: other.publicKey }),
      /signature/,
    );
  });
});

describe("private feed inbox posts", () => {
  it("carry sealed values and epoch keys within the post limit", () => {
    const pub = newPublisher();
    const subs = [newSubscriber(), newSubscriber(), newSubscriber()];
    let envelope: Uint8Array | null = null;
    subs.forEach((s, i) => (envelope = pub.addSubscriber(`s${i}`, s.recipient).envelope));
    const out = pub.publish(9n, 123n, 4n);

    const valuePost = { kind: "private-value" as const, feedId: FEED, round: 9n, blob: bytesToHex(out.blob) };
    const keyPost = { kind: "epoch-key" as const, feedId: FEED, round: pub.epoch, envelope: bytesToHex(envelope!) };
    for (const post of [valuePost, keyPost]) {
      const bytes = encodePost(post);
      assert.ok(bytes.length <= MAX_POST_BYTES, `${post.kind} is ${bytes.length} bytes`);
      assert.deepEqual(decodePost(bytes), post);
    }
  });
});
