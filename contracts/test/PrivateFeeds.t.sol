// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateFeeds} from "../src/PrivateFeeds.sol";
import {MockQorePQC} from "./mocks/MockQorePQC.sol";

contract PrivateFeedsTest is Test {
    address constant VERIFY = address(0x0A01);
    address constant KEY_STATUS = address(0x0A02);
    // Same domain as packages/shared/test/privatefeed.test.ts, so the bytes can be compared.
    address constant REGISTRY = 0x3333333333333333333333333333333333333333;
    uint256 constant CHAIN_ID = 9800;
    uint8 constant ALG = 1;
    bytes32 constant FEED = keccak256("nav");
    bytes32 constant SALT = 0x7777777777777777777777777777777777777777777777777777777777777777;
    bytes32 constant BLOB = 0x5555555555555555555555555555555555555555555555555555555555555555;

    PrivateFeeds feeds;
    MockQorePQC keyStatus;
    address publisher = 0x2222222222222222222222222222222222222222;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        MockQorePQC impl = new MockQorePQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(KEY_STATUS, address(impl).code);
        keyStatus = MockQorePQC(KEY_STATUS);
        deployCodeTo("PrivateFeeds.sol:PrivateFeeds", abi.encode(ALG), REGISTRY);
        feeds = PrivateFeeds(REGISTRY);
        keyStatus.setKey(publisher, true, ALG, _pubkey(publisher));
    }

    function _pubkey(address who) internal pure returns (bytes memory) {
        return abi.encodePacked("pubkey-", who);
    }

    function _sign(address who, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(_pubkey(who), message)));
    }

    function _publish(uint64 round, int256 value) internal returns (bytes32 commitment) {
        commitment = feeds.valueCommitment(publisher, FEED, round, value, 1764000000, SALT);
        bytes memory sig = _sign(publisher, feeds.publishMessage(publisher, FEED, round, 1, commitment, BLOB));
        feeds.publish(publisher, FEED, round, 1, commitment, BLOB, sig);
    }

    // Cross-language vectors: packages/shared/test/privatefeed.test.ts expects these values.
    function test_TagsAndCommitmentMatchSharedPackage() public view {
        assertEq(feeds.VALUE_TAG(), 0x7dd7a9c26aeec81055050322d5f5e30a8d5463bf36eca4d80b34d7283b9ebb3a);
        assertEq(feeds.PUBLISH_TAG(), 0x566e0aa9628faf95ff6a7b04f941da865e64d2a162d978ff1da4189df6d8c50b);
        assertEq(
            feeds.valueCommitment(publisher, FEED, 42, 104_250_000_000, 1764000000, SALT),
            0x6334eb2812559d8318ae8e873a377e8ff66f8eaaa95b6c0b67b624ad66d768a1
        );
    }

    function test_PublishAndVerifyValue() public {
        bytes32 commitment = _publish(1, 104_250_000_000);
        assertTrue(feeds.verifyValue(publisher, FEED, 1, 104_250_000_000, 1764000000, SALT));
        assertEq(feeds.latestRound(publisher, FEED), 1);
        (bytes32 stored, bytes32 blobHash, uint64 epoch, uint64 publishedAt) = feeds.publications(publisher, FEED, 1);
        assertEq(stored, commitment);
        assertEq(blobHash, BLOB);
        assertEq(epoch, 1);
        assertEq(publishedAt, uint64(block.timestamp));
    }

    function test_VerifyRejectsAnotherValueSaltOrTime() public {
        _publish(1, 100);
        assertFalse(feeds.verifyValue(publisher, FEED, 1, 101, 1764000000, SALT));
        assertFalse(feeds.verifyValue(publisher, FEED, 1, 100, 1764000001, SALT));
        assertFalse(feeds.verifyValue(publisher, FEED, 1, 100, 1764000000, bytes32(uint256(SALT) + 1)));
        assertFalse(feeds.verifyValue(publisher, FEED, 2, 100, 1764000000, SALT));
        assertFalse(feeds.verifyValue(address(0xBEEF), FEED, 1, 100, 1764000000, SALT));
    }

    function test_RejectsBadSignature() public {
        bytes32 c = feeds.valueCommitment(publisher, FEED, 1, 100, 1764000000, SALT);
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 1, c, BLOB, hex"00");
    }

    function test_SignatureCoversEveryField() public {
        bytes32 c = feeds.valueCommitment(publisher, FEED, 1, 100, 1764000000, SALT);
        bytes memory sig = _sign(publisher, feeds.publishMessage(publisher, FEED, 1, 1, c, BLOB));
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 2, c, BLOB, sig); // another epoch
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 1, c, bytes32(0), sig); // another blob
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, keccak256("other"), 1, 1, c, BLOB, sig); // another feed
    }

    function test_CannotPublishInAnotherPublishersName() public {
        address other = makeAddr("other");
        keyStatus.setKey(other, true, ALG, _pubkey(other));
        bytes32 c = feeds.valueCommitment(publisher, FEED, 1, 100, 1764000000, SALT);
        bytes memory sig = _sign(other, feeds.publishMessage(publisher, FEED, 1, 1, c, BLOB));
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 1, c, BLOB, sig);
    }

    function test_RejectsUnregisteredOrWrongAlgorithmKey() public {
        bytes32 c = feeds.valueCommitment(publisher, FEED, 1, 100, 1764000000, SALT);
        bytes memory sig = _sign(publisher, feeds.publishMessage(publisher, FEED, 1, 1, c, BLOB));
        keyStatus.setKey(publisher, true, ALG + 1, _pubkey(publisher));
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 1, c, BLOB, sig);
        keyStatus.setKey(publisher, false, ALG, _pubkey(publisher));
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 1, c, BLOB, sig);
    }

    function test_RoundsOnlyIncreaseSoSignaturesCannotBeReplayed() public {
        _publish(5, 100);
        bytes32 c = feeds.valueCommitment(publisher, FEED, 5, 100, 1764000000, SALT);
        bytes memory sig = _sign(publisher, feeds.publishMessage(publisher, FEED, 5, 1, c, BLOB));
        vm.expectRevert(PrivateFeeds.RoundNotIncreasing.selector);
        feeds.publish(publisher, FEED, 5, 1, c, BLOB, sig);
        vm.expectRevert(PrivateFeeds.RoundNotIncreasing.selector);
        feeds.publish(publisher, FEED, 4, 1, c, BLOB, sig);
    }

    function test_RejectsEmptyCommitment() public {
        bytes memory sig = _sign(publisher, feeds.publishMessage(publisher, FEED, 1, 1, bytes32(0), BLOB));
        vm.expectRevert(PrivateFeeds.EmptyCommitment.selector);
        feeds.publish(publisher, FEED, 1, 1, bytes32(0), BLOB, sig);
    }

    function test_FailsClosedWhenPrecompileInactive() public {
        bytes32 c = feeds.valueCommitment(publisher, FEED, 1, 100, 1764000000, SALT);
        bytes memory sig = _sign(publisher, feeds.publishMessage(publisher, FEED, 1, 1, c, BLOB));
        vm.etch(KEY_STATUS, "");
        vm.etch(VERIFY, "");
        vm.expectRevert(PrivateFeeds.BadSignature.selector);
        feeds.publish(publisher, FEED, 1, 1, c, BLOB, sig);
    }
}
