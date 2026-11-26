// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettlementReceipts} from "../src/SettlementReceipts.sol";
import {MockQorePQC} from "./mocks/MockQorePQC.sol";

contract SettlementReceiptsTest is Test {
    address constant VERIFY = address(0x0A01);
    address constant KEY_STATUS = address(0x0A02);
    uint8 constant ALG = 1;

    SettlementReceipts receipts;
    MockQorePQC keyStatus;
    address creator = makeAddr("creator");

    function setUp() public {
        MockQorePQC impl = new MockQorePQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(KEY_STATUS, address(impl).code);
        keyStatus = MockQorePQC(KEY_STATUS);
        receipts = new SettlementReceipts(ALG);
        keyStatus.setKey(creator, true, ALG, _pubkey(creator));
    }

    function _pubkey(address who) internal pure returns (bytes memory) {
        return abi.encodePacked("pubkey-", who);
    }

    function _sign(address who, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(_pubkey(who), message)));
    }

    /// The real receipt of public rollup cloister-dev-1, batch 1, on qorechain-diana
    /// (packages/chain/test/fixtures/receipt-cloister-dev-1-1.json).
    function _cloister() internal pure returns (SettlementReceipts.Anchor memory) {
        return SettlementReceipts.Anchor({
            chainId: "qorechain-diana",
            layerId: "cloister-dev-1",
            batchIndex: 1,
            stateRoot: hex"0000000000000000000000000000000000000000000000000000000000000002",
            validatorSetHash: "",
            transactionCount: 1,
            compressedStateProof: ""
        });
    }

    function test_SignBytesMatchTheRdk() public view {
        // anchorSignBytesForBatch from @qorechain/rdk 0.9.0 for the receipt above.
        bytes memory rdk =
            hex"716f7265636861696e2d6d756c74696c617965722d616e63686f722d7632000000000000000f716f7265636861696e2d6469616e61000000000000000e636c6f69737465722d6465762d31000000000000000100000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000010000000000000000";
        assertEq(receipts.anchorSignBytes(_cloister()), rdk);
    }

    function test_VerifiesTheCreatorsSignature() public view {
        SettlementReceipts.Anchor memory a = _cloister();
        bytes memory sig = _sign(creator, receipts.anchorSignBytes(a));
        assertTrue(receipts.verifyAnchor(a, creator, sig));
    }

    function test_RejectsAChangeToAnySignedField() public view {
        SettlementReceipts.Anchor memory a = _cloister();
        bytes memory sig = _sign(creator, receipts.anchorSignBytes(a));
        SettlementReceipts.Anchor memory b;

        b = _cloister();
        b.chainId = "qorechain-vladi";
        assertFalse(receipts.verifyAnchor(b, creator, sig));
        b = _cloister();
        b.layerId = "cloister-dev-2";
        assertFalse(receipts.verifyAnchor(b, creator, sig));
        b = _cloister();
        b.batchIndex = 2;
        assertFalse(receipts.verifyAnchor(b, creator, sig));
        b = _cloister();
        b.stateRoot = hex"0000000000000000000000000000000000000000000000000000000000000003";
        assertFalse(receipts.verifyAnchor(b, creator, sig));
        b = _cloister();
        b.validatorSetHash = hex"01";
        assertFalse(receipts.verifyAnchor(b, creator, sig));
        b = _cloister();
        b.transactionCount = 2;
        assertFalse(receipts.verifyAnchor(b, creator, sig));
        b = _cloister();
        b.compressedStateProof = hex"01";
        assertFalse(receipts.verifyAnchor(b, creator, sig));
    }

    function test_LengthPrefixesKeepFieldBoundariesUnambiguous() public view {
        // Moving a byte from the chain id to the layer id must change the message.
        SettlementReceipts.Anchor memory a = _cloister();
        SettlementReceipts.Anchor memory b = _cloister();
        (a.chainId, a.layerId) = ("ab", "c");
        (b.chainId, b.layerId) = ("a", "bc");
        assertTrue(keccak256(receipts.anchorSignBytes(a)) != keccak256(receipts.anchorSignBytes(b)));
    }

    function test_RejectsAnotherSignerOrAnUnregisteredKey() public {
        SettlementReceipts.Anchor memory a = _cloister();
        address other = makeAddr("other");
        keyStatus.setKey(other, true, ALG, _pubkey(other));
        bytes memory sig = _sign(creator, receipts.anchorSignBytes(a));
        assertFalse(receipts.verifyAnchor(a, other, sig)); // key resolved from chain, not the receipt
        keyStatus.setKey(creator, true, ALG + 1, _pubkey(creator));
        assertFalse(receipts.verifyAnchor(a, creator, sig));
        keyStatus.setKey(creator, false, ALG, _pubkey(creator));
        assertFalse(receipts.verifyAnchor(a, creator, sig));
    }

    function test_FailsClosedWhenPrecompileInactive() public {
        SettlementReceipts.Anchor memory a = _cloister();
        bytes memory sig = _sign(creator, receipts.anchorSignBytes(a));
        vm.etch(KEY_STATUS, "");
        vm.etch(VERIFY, "");
        assertFalse(receipts.verifyAnchor(a, creator, sig));
    }

    function test_RecordsAValidReceiptOnceAndRejectsAConflict() public {
        SettlementReceipts.Anchor memory a = _cloister();
        receipts.record(a, creator, _sign(creator, receipts.anchorSignBytes(a)));
        bytes32 id = receipts.receiptId(a.chainId, a.layerId, a.batchIndex);
        assertEq(receipts.recorded(id), keccak256(receipts.anchorSignBytes(a)));
        receipts.record(a, creator, _sign(creator, receipts.anchorSignBytes(a))); // same anchor again is fine

        SettlementReceipts.Anchor memory b = _cloister();
        b.stateRoot = hex"0000000000000000000000000000000000000000000000000000000000000003";
        bytes memory sigB = _sign(creator, receipts.anchorSignBytes(b));
        vm.expectRevert(SettlementReceipts.ConflictingReceipt.selector);
        receipts.record(b, creator, sigB);
    }

    function test_RecordRejectsAnInvalidReceipt() public {
        vm.expectRevert(SettlementReceipts.InvalidReceipt.selector);
        receipts.record(_cloister(), creator, hex"00");
    }
}
