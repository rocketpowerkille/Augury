// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QorePQC} from "./libraries/QorePQC.sol";

/// @title SettlementReceipts
/// @notice Verifies QoreChain RDK settlement receipts in Solidity.
///
/// A settlement receipt says that a rollup's creator anchored batch N with a given state root
/// and transaction count. The anchor is signed with the creator's ML-DSA-87 key over the RDK's
/// canonical v2 message, which binds the chain id, the layer, the batch index, the state root,
/// the validator-set hash, the transaction count and the compressed state proof. This contract
/// rebuilds that message byte for byte, resolves the creator's key with pqcKeyStatus (never
/// from the receipt) and checks the signature with pqcVerify.
///
/// What it proves: the creator's registered ML-DSA-87 key signed exactly these anchor fields.
/// What it cannot prove: that QoreChain recorded the anchor. Anchors live in the chain's
/// native x/multilayer state, which the EVM cannot read; the RDK's chain-mode verification
/// (`settle.ts`, `verifySettlementReceipt`) checks that against a node.
contract SettlementReceipts {
    /// @notice The fields of a v2 anchor, as in an RDK settlement receipt.
    struct Anchor {
        /// Native chain id, e.g. `qorechain-diana`.
        string chainId;
        /// The rollup's layer id (for a settlement batch, the rollup id).
        string layerId;
        /// The batch index (the anchor's layer height).
        uint64 batchIndex;
        bytes stateRoot;
        bytes validatorSetHash;
        uint64 transactionCount;
        bytes compressedStateProof;
    }

    /// @notice Domain string of the RDK's v2 anchor message.
    bytes public constant ANCHOR_DOMAIN_V2 = "qorechain-multilayer-anchor-v2";

    /// @notice The algorithm id pqcKeyStatus reports for ML-DSA-87 keys.
    uint8 public immutable mldsaAlgorithmId;

    /// @notice keccak256 of the anchor message of every receipt recorded, by receipt id.
    mapping(bytes32 receiptId => bytes32 anchorHash) public recorded;

    event ReceiptRecorded(
        bytes32 indexed receiptId, string chainId, string layerId, uint64 batchIndex, address creator, bytes stateRoot
    );

    error InvalidReceipt();
    /// The creator signed a different anchor for a batch already recorded.
    error ConflictingReceipt();

    constructor(uint8 mldsaAlgorithmId_) {
        mldsaAlgorithmId = mldsaAlgorithmId_;
    }

    /// @notice The RDK's canonical v2 anchor message: the domain, then each field, with
    /// variable-length fields prefixed by their length as a big-endian uint64.
    function anchorSignBytes(Anchor calldata a) public pure returns (bytes memory) {
        return abi.encodePacked(
            ANCHOR_DOMAIN_V2,
            uint64(bytes(a.chainId).length),
            a.chainId,
            uint64(bytes(a.layerId).length),
            a.layerId,
            a.batchIndex,
            uint64(a.stateRoot.length),
            a.stateRoot,
            uint64(a.validatorSetHash.length),
            a.validatorSetHash,
            a.transactionCount,
            uint64(a.compressedStateProof.length),
            a.compressedStateProof
        );
    }

    /// @notice True if `creator`'s registered ML-DSA-87 key signed `a`. `creator` is the EVM
    /// address of the rollup creator's unified account.
    function verifyAnchor(Anchor calldata a, address creator, bytes calldata signature)
        public
        view
        returns (bool)
    {
        (bool registered, uint8 algorithmId, bytes memory pubkey) = QorePQC.keyStatus(creator);
        if (!registered || algorithmId != mldsaAlgorithmId) return false;
        return QorePQC.verify(pubkey, signature, anchorSignBytes(a));
    }

    /// @notice The id of a receipt: its chain, layer and batch.
    function receiptId(string calldata chainId, string calldata layerId, uint64 batchIndex)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, layerId, batchIndex));
    }

    /// @notice Verify a receipt's anchor signature and record it on chain. Anyone may record.
    function record(Anchor calldata a, address creator, bytes calldata signature) external {
        if (!verifyAnchor(a, creator, signature)) revert InvalidReceipt();
        bytes32 id = receiptId(a.chainId, a.layerId, a.batchIndex);
        bytes32 anchorHash = keccak256(anchorSignBytes(a));
        bytes32 previous = recorded[id];
        if (previous != bytes32(0) && previous != anchorHash) revert ConflictingReceipt();
        recorded[id] = anchorHash;
        emit ReceiptRecorded(id, a.chainId, a.layerId, a.batchIndex, creator, a.stateRoot);
    }
}
