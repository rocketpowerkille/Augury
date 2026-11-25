import { randomBytes } from "node:crypto";
import { mldsa87 } from "@qorechain/pqc";
import {
  EpochKeyManager,
  openBatch,
  openEpochKey,
  sealBatch,
  type EpochKey,
  type EpochRotation,
  type SealKeyPair,
  type SealMode,
  type SealRecipient,
} from "@qorechain/qoreseal";
import { decodeInt256At, decodeUintAt, encodeAddress, encodeBytes32, encodeInt256, encodeUint, wordAt } from "./abi.ts";
import { bytesEqual, bytesToHex, concatBytes, hexToBytes, sha256, type Hex } from "./bytes.ts";

/**
 * Private feeds: values only current subscribers can read, such as a tokenized fund's NAV.
 *
 * The publisher seals each value with a QoreSeal epoch key (ML-KEM-1024). Every change of
 * subscribers starts a new epoch with a fresh key sealed to the remaining subscribers, so a
 * lapsed subscriber cannot read later values and a new one cannot read earlier ones. The
 * sealed value goes to the rollup inbox; a salted SHA-256 commitment to it, signed with the
 * publisher's ML-DSA-87 key, goes to the PrivateFeeds contract. A subscriber opens the value,
 * checks it against the signed commitment and can prove it to any contract with
 * `PrivateFeeds.verifyValue`.
 *
 * Every message here byte-matches contracts/src/PrivateFeeds.sol.
 *
 * Security-relevant: changes here need review by the team's PQC/security member.
 */

/** keccak256 of each tag string, as declared in PrivateFeeds. Checked against the contract in tests. */
export const PRIVATE_TAGS = {
  value: "0x7dd7a9c26aeec81055050322d5f5e30a8d5463bf36eca4d80b34d7283b9ebb3a",
  publish: "0x566e0aa9628faf95ff6a7b04f941da865e64d2a162d978ff1da4189df6d8c50b",
} as const satisfies Record<string, Hex>;

/** Where private-feed messages are valid: the EVM chain id and the PrivateFeeds address. */
export interface PrivateDomain {
  chainId: bigint;
  registry: Hex;
}

/** One value of a private feed, as sealed for subscribers. */
export interface PrivateValue {
  feedId: Hex;
  round: bigint;
  /** The value with 8 decimals. */
  value: bigint;
  /** Unix seconds when the value was observed. */
  observedAt: bigint;
  /** 32 random bytes; without them nobody can test guessed values against the commitment. */
  salt: Hex;
}

/** What the publisher signs and PrivateFeeds stores. */
export interface Publication {
  feedId: Hex;
  round: bigint;
  epoch: bigint;
  commitment: Hex;
  /** QoreSeal's ciphertext commitment (SHA3-256) of the sealed value posted to the inbox. */
  blobHash: Hex;
}

const VALUE_LENGTH = 5 * 32;

/** The plaintext sealed for subscribers: feed, round, value, time and salt, as five words. */
export function privateValueBytes(v: PrivateValue): Uint8Array {
  return concatBytes(
    encodeBytes32(v.feedId),
    encodeUint(v.round, 64),
    encodeInt256(v.value),
    encodeUint(v.observedAt, 64),
    encodeBytes32(v.salt),
  );
}

/** Read sealed value bytes back. Throws on anything that does not re-encode to the same bytes. */
export function decodePrivateValue(bytes: Uint8Array): PrivateValue {
  if (bytes.length !== VALUE_LENGTH) throw new Error(`private value must be ${VALUE_LENGTH} bytes`);
  const v: PrivateValue = {
    feedId: bytesToHex(wordAt(bytes, 0)),
    round: decodeUintAt(bytes, 1),
    value: decodeInt256At(bytes, 2),
    observedAt: decodeUintAt(bytes, 3),
    salt: bytesToHex(wordAt(bytes, 4)),
  };
  let canonical = false;
  try {
    canonical = bytesEqual(privateValueBytes(v), bytes);
  } catch {
    // A word out of its type's range cannot be re-encoded.
  }
  if (!canonical) throw new Error("malformed private value");
  return v;
}

/** `PrivateFeeds.valueCommitment`. */
export function valueCommitment(d: PrivateDomain, publisher: Hex, v: PrivateValue): Hex {
  return bytesToHex(
    sha256(
      concatBytes(
        encodeBytes32(PRIVATE_TAGS.value),
        encodeUint(d.chainId),
        encodeAddress(d.registry),
        encodeAddress(publisher),
        privateValueBytes(v).subarray(0, 4 * 32),
        encodeBytes32(v.salt),
      ),
    ),
  );
}

/** `PrivateFeeds.publishMessage`: what the publisher signs with ML-DSA-87. */
export function publishMessage(d: PrivateDomain, publisher: Hex, p: Publication): Uint8Array {
  return concatBytes(
    encodeBytes32(PRIVATE_TAGS.publish),
    encodeUint(d.chainId),
    encodeAddress(d.registry),
    encodeAddress(publisher),
    encodeBytes32(p.feedId),
    encodeUint(p.round, 64),
    encodeUint(p.epoch, 64),
    encodeBytes32(p.commitment),
    encodeBytes32(p.blobHash),
  );
}

/** The QoreSeal batch context of a private feed, so a blob cannot be passed off as another feed's. */
export function privateFeedContext(feedId: Hex): string {
  return `augury-private-feed:${feedId.toLowerCase()}`;
}

/** The QoreSeal purpose of a private feed's epoch-key envelopes. */
export function epochKeyPurpose(feedId: Hex): string {
  return `augury-epoch-key:${feedId.toLowerCase()}`;
}

export interface PublishedValue {
  /** The sealed value, to post to the rollup inbox. */
  blob: Uint8Array;
  publication: Publication;
  /** ML-DSA-87 signature over `publishMessage`, for `PrivateFeeds.publish`. */
  signature: Uint8Array;
  value: PrivateValue;
}

/** The publisher of one private feed: keeps its epoch keys and subscribers, seals and signs values. */
export class PrivateFeedPublisher {
  readonly feedId: Hex;
  readonly #domain: PrivateDomain;
  readonly #publisher: Hex;
  readonly #secretKey: Uint8Array;
  readonly #keys: EpochKeyManager;

  constructor(args: {
    /** Native chain id used by QoreSeal, e.g. `qorechain-diana`. */
    sealChainId: string;
    domain: PrivateDomain;
    /** The publisher's EVM address; its registered ML-DSA-87 key signs publications. */
    publisher: Hex;
    secretKey: Uint8Array;
    feedId: Hex;
    /** `mlkem` for subscribers known only by their ML-KEM key in the chain's KEM registry. */
    mode?: SealMode;
    /** Epoch keys restored from `exportKeys`, oldest first. */
    history?: EpochKey[];
  }) {
    this.feedId = args.feedId;
    this.#domain = args.domain;
    this.#publisher = args.publisher;
    this.#secretKey = args.secretKey;
    this.#keys = new EpochKeyManager({
      chainId: args.sealChainId,
      purpose: epochKeyPurpose(args.feedId),
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.history ? { history: args.history } : {}),
    });
  }

  get epoch(): bigint {
    return this.#keys.epoch;
  }

  subscribers(): string[] {
    return this.#keys.members();
  }

  /** Add a subscriber. A new epoch starts; post its envelope so every subscriber gets the key. */
  addSubscriber(id: string, recipient: SealRecipient): EpochRotation {
    return this.#keys.addMember(id, recipient);
  }

  /** Remove a subscriber. A new epoch starts that it cannot read. */
  removeSubscriber(id: string): EpochRotation {
    return this.#keys.removeMember(id);
  }

  /** Every epoch key, oldest first. It opens every value of the feed: store it like a secret key. */
  exportKeys(): EpochKey[] {
    return this.#keys.exportKeys();
  }

  /** Seal `value` for the current subscribers and sign its publication. `salt` is for tests only. */
  publish(round: bigint, value: bigint, observedAt: bigint, salt?: Hex): PublishedValue {
    const v: PrivateValue = {
      feedId: this.feedId,
      round,
      value,
      observedAt,
      salt: salt ?? bytesToHex(new Uint8Array(randomBytes(32))),
    };
    const sealed = sealBatch({
      epochKey: this.#keys.currentKey,
      context: privateFeedContext(this.feedId),
      batchIndex: round,
      data: privateValueBytes(v),
    });
    const publication: Publication = {
      feedId: this.feedId,
      round,
      epoch: sealed.epoch,
      commitment: valueCommitment(this.#domain, this.#publisher, v),
      blobHash: bytesToHex(sealed.ciphertextCommitment),
    };
    const signature = mldsa87.sign(this.#secretKey, publishMessage(this.#domain, this.#publisher, publication));
    return { blob: sealed.blob, publication, signature, value: v };
  }
}

/** A subscriber of one private feed: collects epoch keys and opens and checks values. */
export class PrivateFeedSubscriber {
  readonly feedId: Hex;
  readonly #sealChainId: string;
  readonly #domain: PrivateDomain;
  readonly #publisher: Hex;
  readonly #keys: SealKeyPair;
  readonly #epochKeys = new Map<bigint, Uint8Array>();

  constructor(args: { sealChainId: string; domain: PrivateDomain; publisher: Hex; feedId: Hex; keys: SealKeyPair }) {
    this.feedId = args.feedId;
    this.#sealChainId = args.sealChainId;
    this.#domain = args.domain;
    this.#publisher = args.publisher;
    this.#keys = args.keys;
  }

  /** Open an epoch-key envelope sealed to this subscriber and keep the key. Throws if it is not for us. */
  acceptEpochKey(envelope: Uint8Array): bigint {
    const k = openEpochKey({
      chainId: this.#sealChainId,
      purpose: epochKeyPurpose(this.feedId),
      envelope,
      keys: this.#keys,
    });
    this.#epochKeys.set(k.epoch, k.key);
    return k.epoch;
  }

  /**
   * Open a sealed value and check it against its publication: the blob is the one signed,
   * it belongs to this feed and round, and the value matches the commitment. With the
   * publisher's ML-DSA-87 key, the publication's signature is checked too. Throws on any
   * mismatch, or if this subscriber has no key for the value's epoch.
   */
  open(args: { blob: Uint8Array; publication: Publication; signature?: Uint8Array; publisherKey?: Uint8Array }): PrivateValue {
    const { blob, publication } = args;
    if (publication.feedId.toLowerCase() !== this.feedId.toLowerCase()) throw new Error("publication is for another feed");
    if (args.signature || args.publisherKey) {
      if (!args.signature || !args.publisherKey) throw new Error("need both the signature and the publisher's key");
      if (!mldsa87.verify(args.publisherKey, publishMessage(this.#domain, this.#publisher, publication), args.signature)) {
        throw new Error("publication signature does not verify");
      }
    }
    const opened = openBatch({ blob, keys: (epoch) => this.#epochKeys.get(epoch) });
    if (opened.context !== privateFeedContext(this.feedId)) throw new Error("sealed value is for another feed");
    if (opened.batchIndex !== publication.round || opened.epoch !== publication.epoch) {
      throw new Error("sealed value is for another round or epoch");
    }
    if (!bytesEqual(opened.ciphertextCommitment, hexToBytes(publication.blobHash))) {
      throw new Error("sealed value is not the one published");
    }
    const v = decodePrivateValue(opened.data);
    if (v.feedId.toLowerCase() !== this.feedId.toLowerCase() || v.round !== publication.round) {
      throw new Error("sealed value names another feed or round");
    }
    if (valueCommitment(this.#domain, this.#publisher, v) !== publication.commitment.toLowerCase()) {
      throw new Error("value does not match the published commitment");
    }
    return v;
  }
}
