// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QorePQC} from "./libraries/QorePQC.sol";

/// @title PrivateFeeds
/// @notice Commitments to private feed values, such as a tokenized fund's NAV.
///
/// A publisher seals each value with a QoreSeal epoch key (ML-KEM-1024) that only its current
/// subscribers hold, posts the sealed value to the rollup inbox and publishes here a salted
/// SHA-256 commitment to it, signed with its ML-DSA-87 key. Nobody else learns the value: the
/// salt travels only inside the sealed value. A subscriber can prove to any contract that the
/// value it holds is the one the publisher published, by opening the commitment with
/// `verifyValue`.
///
/// Publications are authorized by the publisher's ML-DSA-87 signature, checked with the
/// pqcVerify precompile against the key pqcKeyStatus reports for the publisher. No logic
/// reads `msg.sender`, so anyone may relay a signed publication.
contract PrivateFeeds {
    struct Publication {
        bytes32 commitment;
        /// @dev QoreSeal's ciphertext commitment (SHA3-256) of the sealed value posted to the
        /// inbox, so subscribers can check they opened the blob the publisher signed.
        bytes32 blobHash;
        uint64 epoch;
        uint64 publishedAt;
    }

    bytes32 public constant VALUE_TAG = keccak256("AUGURY_PRIVATE_VALUE_V1");
    bytes32 public constant PUBLISH_TAG = keccak256("AUGURY_PRIVATE_PUBLISH_V1");

    /// @notice The algorithm id pqcKeyStatus reports for ML-DSA-87 keys.
    uint8 public immutable mldsaAlgorithmId;

    mapping(address publisher => mapping(bytes32 feedId => mapping(uint64 round => Publication)))
        public publications;
    mapping(address publisher => mapping(bytes32 feedId => uint64)) public latestRound;

    event Published(
        address indexed publisher,
        bytes32 indexed feedId,
        uint64 indexed round,
        uint64 epoch,
        bytes32 commitment,
        bytes32 blobHash
    );

    error BadSignature();
    error RoundNotIncreasing();
    error EmptyCommitment();

    constructor(uint8 mldsaAlgorithmId_) {
        mldsaAlgorithmId = mldsaAlgorithmId_;
    }

    /// @notice The commitment to a value: SHA-256 over the domain, the publication's
    /// coordinates, the value and a 32-byte random salt known only to subscribers.
    function valueCommitment(
        address publisher,
        bytes32 feedId,
        uint64 round,
        int256 value,
        uint64 observedAt,
        bytes32 salt
    ) public view returns (bytes32) {
        return sha256(
            abi.encode(
                VALUE_TAG, block.chainid, address(this), publisher, feedId, round, value, observedAt, salt
            )
        );
    }

    /// @notice The message a publisher signs to publish a commitment.
    function publishMessage(
        address publisher,
        bytes32 feedId,
        uint64 round,
        uint64 epoch,
        bytes32 commitment,
        bytes32 blobHash
    ) public view returns (bytes memory) {
        return abi.encode(
            PUBLISH_TAG, block.chainid, address(this), publisher, feedId, round, epoch, commitment, blobHash
        );
    }

    /// @notice Publish the commitment for `round` of `publisher`'s feed `feedId`, signed with
    /// the publisher's registered ML-DSA-87 key. Rounds only increase, so a signature cannot be
    /// replayed.
    function publish(
        address publisher,
        bytes32 feedId,
        uint64 round,
        uint64 epoch,
        bytes32 commitment,
        bytes32 blobHash,
        bytes calldata signature
    ) external {
        if (round <= latestRound[publisher][feedId]) revert RoundNotIncreasing();
        if (commitment == bytes32(0)) revert EmptyCommitment();
        bytes memory message = publishMessage(publisher, feedId, round, epoch, commitment, blobHash);
        (bool registered, uint8 algorithmId, bytes memory pubkey) = QorePQC.keyStatus(publisher);
        if (!registered || algorithmId != mldsaAlgorithmId || !QorePQC.verify(pubkey, signature, message)) {
            revert BadSignature();
        }
        publications[publisher][feedId][round] =
            Publication({commitment: commitment, blobHash: blobHash, epoch: epoch, publishedAt: uint64(block.timestamp)});
        latestRound[publisher][feedId] = round;
        emit Published(publisher, feedId, round, epoch, commitment, blobHash);
    }

    /// @notice True if `value` (observed at `observedAt`, with `salt`) is what `publisher`
    /// published for `round` of `feedId`. A consumer contract calls this with the opened value.
    function verifyValue(
        address publisher,
        bytes32 feedId,
        uint64 round,
        int256 value,
        uint64 observedAt,
        bytes32 salt
    ) external view returns (bool) {
        Publication storage p = publications[publisher][feedId][round];
        return p.publishedAt != 0
            && p.commitment == valueCommitment(publisher, feedId, round, value, observedAt, salt);
    }
}
