// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuguryHub} from "../src/AuguryHub.sol";
import {MockQorePQC} from "./mocks/MockQorePQC.sol";

contract AuguryHubTest is Test {
    address constant VERIFY = address(0x0A01);
    address constant KEY_STATUS = address(0x0A02);
    // Same domain as packages/shared/test/messages.test.ts, so the bytes can be compared.
    address constant HUB_ADDRESS = 0x1111111111111111111111111111111111111111;
    uint256 constant CHAIN_ID = 9800;
    // ML-DSA-87 (AlgorithmDilithium5) in @qorechain/sdk 0.14.0.
    uint8 constant ALG = 1;

    bytes32 constant FEED = 0x4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad;
    uint64 constant WINDOW = 1 hours;
    uint64 constant EXIT_DELAY = 2 hours;
    uint256 constant MIN_STAKE = 1 ether;
    uint256 constant MIN_BOND = 10 ether;

    AuguryHub hub;
    MockQorePQC keyStatus;
    address sequencer = makeAddr("sequencer");
    address[] reporterList;
    address challenger = makeAddr("challenger");

    function setUp() public {
        vm.chainId(CHAIN_ID);
        MockQorePQC impl = new MockQorePQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(KEY_STATUS, address(impl).code);
        keyStatus = MockQorePQC(KEY_STATUS);

        deployCodeTo(
            "AuguryHub.sol:AuguryHub",
            abi.encode(sequencer, ALG, MIN_STAKE, MIN_BOND, WINDOW, EXIT_DELAY, uint32(3), uint32(16)),
            HUB_ADDRESS
        );
        hub = AuguryHub(HUB_ADDRESS);

        _registerKey(sequencer);
        vm.deal(address(this), 1000 ether);
        hub.bondSequencer{value: MIN_BOND}();

        for (uint256 i = 0; i < 5; i++) {
            address r = makeAddr(string.concat("reporter", vm.toString(i)));
            _registerKey(r);
            vm.deal(r, 10 ether);
            vm.prank(r);
            hub.stake{value: MIN_STAKE}(r);
            reporterList.push(r);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    function _pubkey(address who) internal pure returns (bytes memory) {
        return abi.encodePacked("pubkey-", who);
    }

    function _registerKey(address who) internal {
        keyStatus.setKey(who, true, ALG, _pubkey(who));
    }

    function _sign(address who, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(_pubkey(who), message)));
    }

    function _report(uint64 round, uint256 i, int256 price)
        internal
        view
        returns (AuguryHub.SignedReport memory r)
    {
        address who = reporterList[i];
        uint64 observedAt = uint64(block.timestamp);
        bytes32 salt = keccak256(abi.encode("salt", who, round, price));
        r = AuguryHub.SignedReport({
            reporter: who,
            price: price,
            observedAt: observedAt,
            salt: salt,
            signature: _sign(who, hub.reportMessage(FEED, round, who, price, observedAt, salt))
        });
    }

    function _reports(uint64 round, int256[] memory prices)
        internal
        view
        returns (AuguryHub.SignedReport[] memory rs)
    {
        rs = new AuguryHub.SignedReport[](prices.length);
        for (uint256 i = 0; i < prices.length; i++) rs[i] = _report(round, i, prices[i]);
    }

    function _root(uint64 round, AuguryHub.SignedReport[] memory rs) internal view returns (bytes32) {
        bytes memory leaves;
        for (uint256 i = 0; i < rs.length; i++) {
            leaves = bytes.concat(leaves, hub.reportLeaf(FEED, round, rs[i]));
        }
        return sha256(leaves);
    }

    function _batchSig(uint64 round, AuguryHub.SignedReport[] memory rs, int256 price)
        internal
        view
        returns (bytes memory)
    {
        return _sign(sequencer, hub.batchMessage(FEED, round, price, _root(round, rs), uint32(rs.length)));
    }

    function _post(uint64 round, AuguryHub.SignedReport[] memory rs, int256 price) internal {
        hub.postBatch(FEED, round, price, rs, _batchSig(round, rs, price));
    }

    function _prices3(int256 a, int256 b, int256 c) internal pure returns (int256[] memory p) {
        p = new int256[](3);
        (p[0], p[1], p[2]) = (a, b, c);
    }

    // ---------------------------------------------------------------------------------------
    // Cross-language encoding (same vectors as packages/shared)
    // ---------------------------------------------------------------------------------------

    function test_TagsMatchSharedPackage() public view {
        assertEq(hub.REPORT_TAG(), 0xde27b797c84cbdc91a7c574a77ca25092b7ae1342f803884235a3775df6eafba);
        assertEq(hub.BATCH_TAG(), 0x2360d05af57c90d2666345da3fbbeaa6d5b62565e01282b906e9abf7287cd413);
        assertEq(
            hub.REPORTER_EXIT_TAG(), 0x0b419c48f0845fdbb68f3a9f58252d2d204e4588774a4262a5b6c0d87e1e4145
        );
        assertEq(
            hub.REPORTER_WITHDRAW_TAG(),
            0x37b6364c94d7831cde44bed5ea7b3fff4290cd7077dc378636c7d49078ce0280
        );
        assertEq(hub.BOND_EXIT_TAG(), 0xd3f71b1069ddbdf62902805fa93b167435cbf4e222e024f61b4385e0a3004789);
        assertEq(
            hub.BOND_WITHDRAW_TAG(), 0x79f6289368f958a018d2301d4c6726046720deb86fd682c2cfad240dc6107453
        );
    }

    function test_ReportMessageMatchesSharedPackage() public view {
        bytes memory expected = bytes.concat(
            hex"de27b797c84cbdc91a7c574a77ca25092b7ae1342f803884235a3775df6eafba",
            hex"0000000000000000000000000000000000000000000000000000000000002648",
            hex"0000000000000000000000001111111111111111111111111111111111111111",
            hex"4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad",
            hex"000000000000000000000000000000000000000000000000000000000000002a",
            hex"0000000000000000000000002222222222222222222222222222222222222222",
            hex"000000000000000000000000000000000000000000000000000008d554dfa840",
            hex"0000000000000000000000000000000000000000000000000000000069248100",
            hex"7777777777777777777777777777777777777777777777777777777777777777"
        );
        bytes memory actual = hub.reportMessage(
            FEED,
            42,
            0x2222222222222222222222222222222222222222,
            9712345000000,
            1764000000,
            0x7777777777777777777777777777777777777777777777777777777777777777
        );
        assertEq(actual, expected);
    }

    // ---------------------------------------------------------------------------------------
    // Configuration and staking
    // ---------------------------------------------------------------------------------------

    function test_RejectsBadConfig() public {
        vm.expectRevert(AuguryHub.InvalidConfig.selector);
        new AuguryHub(sequencer, ALG, MIN_STAKE, MIN_BOND, WINDOW, WINDOW - 1, 3, 16);
        vm.expectRevert(AuguryHub.InvalidConfig.selector);
        new AuguryHub(sequencer, ALG, MIN_STAKE, MIN_BOND, WINDOW, EXIT_DELAY, 5, 4);
        vm.expectRevert(AuguryHub.InvalidConfig.selector);
        new AuguryHub(address(0), ALG, MIN_STAKE, MIN_BOND, WINDOW, EXIT_DELAY, 3, 16);
    }

    function test_StakeRequiresRegisteredKey() public {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuguryHub.KeyNotRegistered.selector, stranger));
        hub.stake{value: 1 ether}(stranger);
    }

    function test_StakeRejectsWrongAlgorithm() public {
        address other = makeAddr("other");
        keyStatus.setKey(other, true, ALG + 1, _pubkey(other));
        vm.deal(other, 1 ether);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(AuguryHub.KeyNotRegistered.selector, other));
        hub.stake{value: 1 ether}(other);
    }

    function test_AnyoneCanFundAReportersStake() public {
        address r = reporterList[0];
        address funder = makeAddr("funder");
        vm.deal(funder, 1 ether);
        vm.prank(funder);
        hub.stake{value: 1 ether}(r);
        (uint256 total,,,) = hub.reporters(r);
        assertEq(total, MIN_STAKE + 1 ether);
        (uint256 funderStake,,,) = hub.reporters(funder);
        assertEq(funderStake, 0);
    }

    function test_RewardGoesToRewardToNotCaller() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 1);
        address payable payee = payable(makeAddr("payee"));
        // The test contract cannot receive QOR, but it can still prove fraud for someone else.
        hub.challengeBatch(FEED, 1, rs, payee);
        assertEq(payee.balance, MIN_BOND / 2);
    }

    function test_ReporterExitAndWithdraw() public {
        address r = reporterList[0];
        address payable to = payable(makeAddr("payout"));

        hub.requestExit(r, _sign(r, hub.exitMessage(hub.REPORTER_EXIT_TAG(), r, 0)));
        assertFalse(hub.isActiveAt(r, uint64(block.timestamp)));

        bytes memory sig = _sign(r, hub.withdrawMessage(hub.REPORTER_WITHDRAW_TAG(), r, to, 1));
        vm.expectRevert(AuguryHub.ExitNotReady.selector);
        hub.withdrawStake(r, to, sig);

        vm.warp(block.timestamp + EXIT_DELAY);
        hub.withdrawStake(r, to, sig);
        assertEq(to.balance, MIN_STAKE);
        (uint256 left,,,) = hub.reporters(r);
        assertEq(left, 0);
    }

    function test_WithdrawSignatureCannotBeRedirected() public {
        address r = reporterList[0];
        hub.requestExit(r, _sign(r, hub.exitMessage(hub.REPORTER_EXIT_TAG(), r, 0)));
        vm.warp(block.timestamp + EXIT_DELAY);
        bytes memory sig =
            _sign(r, hub.withdrawMessage(hub.REPORTER_WITHDRAW_TAG(), r, makeAddr("payout"), 1));
        vm.expectRevert(AuguryHub.BadSignature.selector);
        hub.withdrawStake(r, payable(makeAddr("thief")), sig);
    }

    function test_ExitSignatureCannotBeReplayed() public {
        address r = reporterList[0];
        bytes memory sig = _sign(r, hub.exitMessage(hub.REPORTER_EXIT_TAG(), r, 0));
        hub.requestExit(r, sig);
        vm.warp(block.timestamp + EXIT_DELAY);
        hub.withdrawStake(
            r,
            payable(r),
            _sign(r, hub.withdrawMessage(hub.REPORTER_WITHDRAW_TAG(), r, r, 1))
        );
        vm.prank(r);
        hub.stake{value: MIN_STAKE}(r);
        vm.expectRevert(AuguryHub.BadSignature.selector);
        hub.requestExit(r, sig);
    }

    function test_SequencerBondExitAndWithdraw() public {
        hub.requestBondExit(_sign(sequencer, hub.exitMessage(hub.BOND_EXIT_TAG(), sequencer, 0)));
        address payable to = payable(makeAddr("bondPayout"));
        vm.warp(block.timestamp + EXIT_DELAY);
        hub.withdrawBond(
            to, _sign(sequencer, hub.withdrawMessage(hub.BOND_WITHDRAW_TAG(), sequencer, to, 1))
        );
        assertEq(to.balance, MIN_BOND);
        assertEq(hub.sequencerBond(), 0);
    }

    // ---------------------------------------------------------------------------------------
    // Batches and reads
    // ---------------------------------------------------------------------------------------

    function test_PostBatchAndReadPrice() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        (int256 price, uint8 decimals, uint64 round, uint64 settledAt) = hub.getPrice(FEED);
        assertEq(price, 101);
        assertEq(decimals, 8);
        assertEq(round, 1);
        assertEq(settledAt, block.timestamp);
    }

    function test_FinalPriceWaitsForChallengeWindow() public {
        _post(1, _reports(1, _prices3(100, 102, 101)), 101);
        vm.expectRevert(AuguryHub.NoPrice.selector);
        hub.getFinalPrice(FEED);
        vm.warp(block.timestamp + WINDOW);
        (int256 price,,,) = hub.getFinalPrice(FEED);
        assertEq(price, 101);
    }

    function test_RejectsBatchWithBadSignature() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        bytes memory wrongSig =
            _sign(reporterList[0], hub.batchMessage(FEED, 1, 101, _root(1, rs), 3));
        vm.expectRevert(AuguryHub.BadSignature.selector);
        hub.postBatch(FEED, 1, 101, rs, wrongSig);
    }

    function test_BatchRootComesFromPostedReports() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        (, bytes32 root, uint32 count,,,) = hub.batches(FEED, 1);
        assertEq(root, _root(1, rs));
        assertEq(count, 3);
    }

    function test_CannotPublishOtherReportsThanSigned() public {
        AuguryHub.SignedReport[] memory signedFor = _reports(1, _prices3(100, 102, 101));
        bytes memory sig = _batchSig(1, signedFor, 101);
        AuguryHub.SignedReport[] memory published = _reports(1, _prices3(1, 1, 1));
        vm.expectRevert(AuguryHub.BadSignature.selector);
        hub.postBatch(FEED, 1, 101, published, sig);
    }

    function test_RejectsNonIncreasingRound() public {
        _post(2, _reports(2, _prices3(100, 102, 101)), 101);
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        bytes memory sig = _batchSig(1, rs, 101);
        vm.expectRevert(AuguryHub.RoundNotIncreasing.selector);
        hub.postBatch(FEED, 1, 101, rs, sig);
    }

    function test_RejectsTooFewReports() public {
        int256[] memory p = new int256[](2);
        (p[0], p[1]) = (100, 101);
        AuguryHub.SignedReport[] memory rs = _reports(1, p);
        bytes memory sig = _batchSig(1, rs, 100);
        vm.expectRevert(AuguryHub.ReportCountOutOfRange.selector);
        hub.postBatch(FEED, 1, 100, rs, sig);
    }

    function test_RejectsBatchWithoutBond() public {
        hub.requestBondExit(_sign(sequencer, hub.exitMessage(hub.BOND_EXIT_TAG(), sequencer, 0)));
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        bytes memory sig = _batchSig(1, rs, 101);
        vm.expectRevert(AuguryHub.BondTooLow.selector);
        hub.postBatch(FEED, 1, 101, rs, sig);
    }

    function test_FailsClosedWhenPrecompileInactive() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        bytes memory sig = _batchSig(1, rs, 101);
        vm.etch(VERIFY, "");
        vm.expectRevert(AuguryHub.BadSignature.selector);
        hub.postBatch(FEED, 1, 101, rs, sig);
    }

    // ---------------------------------------------------------------------------------------
    // Fraud proofs
    // ---------------------------------------------------------------------------------------

    function test_ChallengeWrongMedianSlashesSequencer() public {
        _post(1, _reports(1, _prices3(100, 102, 101)), 101);
        AuguryHub.SignedReport[] memory rs = _reports(2, _prices3(100, 102, 101));
        _post(2, rs, 1); // lie: the median is 101

        vm.prank(challenger);
        hub.challengeBatch(FEED, 2, rs, payable(challenger));

        assertEq(challenger.balance, MIN_BOND / 2);
        assertEq(hub.sequencerBond(), 0);
        assertEq(hub.slashedTotal(), MIN_BOND - MIN_BOND / 2);
        (,,,,, AuguryHub.Status status) = hub.batches(FEED, 2);
        assertEq(uint8(status), uint8(AuguryHub.Status.Invalid));

        // Readers fall back to the last valid round.
        (int256 price,, uint64 round,) = hub.getPrice(FEED);
        assertEq(price, 101);
        assertEq(round, 1);
    }

    function test_ChallengeHonestBatchReverts() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        vm.expectRevert(AuguryHub.NoFraud.selector);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
    }

    function test_ChallengeWithWrongReportsReverts() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 1);
        rs[0].price = 1; // not the reports that were posted
        vm.expectRevert(AuguryHub.RootMismatch.selector);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
    }

    function test_ChallengeCatchesBadReportSignature() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        rs[1].signature = hex"00";
        _post(1, rs, 101);
        vm.prank(challenger);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        (,,,,, AuguryHub.Status status) = hub.batches(FEED, 1);
        assertEq(uint8(status), uint8(AuguryHub.Status.Invalid));
        assertEq(challenger.balance, MIN_BOND / 2);
    }

    function test_ChallengeCatchesDuplicateReporter() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        rs[2] = rs[0];
        _post(1, rs, 100);
        vm.prank(challenger);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        (,,,,, AuguryHub.Status status) = hub.batches(FEED, 1);
        assertEq(uint8(status), uint8(AuguryHub.Status.Invalid));
        assertEq(challenger.balance, MIN_BOND / 2);
    }

    function test_ChallengeCatchesInactiveReporter() public {
        address r = reporterList[0];
        hub.requestExit(r, _sign(r, hub.exitMessage(hub.REPORTER_EXIT_TAG(), r, 0)));
        vm.warp(block.timestamp + 1);
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        vm.prank(challenger);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        (,,,,, AuguryHub.Status status) = hub.batches(FEED, 1);
        assertEq(uint8(status), uint8(AuguryHub.Status.Invalid));
        assertEq(challenger.balance, MIN_BOND / 2);
    }

    function test_ExitAfterPostDoesNotMakeBatchFraudulent() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        vm.warp(block.timestamp + 1);
        address r = reporterList[0];
        hub.requestExit(r, _sign(r, hub.exitMessage(hub.REPORTER_EXIT_TAG(), r, 0)));
        vm.expectRevert(AuguryHub.NoFraud.selector);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
    }

    function test_ChallengeAfterWindowReverts() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 1);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(AuguryHub.BatchNotChallengeable.selector);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
    }

    function test_EquivocationSlashesReporter() public {
        AuguryHub.SignedReport memory a = _report(1, 0, 100);
        AuguryHub.SignedReport memory b = _report(1, 0, 200);
        vm.prank(challenger);
        hub.reportEquivocation(FEED, 1, a, b, payable(challenger));
        (uint256 left,,,) = hub.reporters(reporterList[0]);
        assertEq(left, 0);
        assertEq(challenger.balance, MIN_STAKE / 2);
    }

    function test_SamePriceWithAnotherSaltIsEquivocation() public {
        AuguryHub.SignedReport memory a = _report(1, 0, 100);
        // A separate struct: `b = a` would alias the same memory.
        bytes32 otherSalt = bytes32(uint256(a.salt) + 1);
        AuguryHub.SignedReport memory b = AuguryHub.SignedReport({
            reporter: a.reporter,
            price: a.price,
            observedAt: a.observedAt,
            salt: otherSalt,
            signature: _sign(
                a.reporter, hub.reportMessage(FEED, 1, a.reporter, a.price, a.observedAt, otherSalt)
            )
        });
        hub.reportEquivocation(FEED, 1, a, b, payable(challenger));
        (uint256 left,,,) = hub.reporters(reporterList[0]);
        assertEq(left, 0);
    }

    function test_SameReportTwiceIsNotEquivocation() public {
        AuguryHub.SignedReport memory a = _report(1, 0, 100);
        vm.expectRevert(AuguryHub.NotEquivocation.selector);
        hub.reportEquivocation(FEED, 1, a, a, payable(challenger));
    }

    function test_EquivocationNeedsValidSignatures() public {
        AuguryHub.SignedReport memory a = _report(1, 0, 100);
        AuguryHub.SignedReport memory b = _report(1, 0, 200);
        b.signature = hex"01";
        vm.expectRevert(AuguryHub.BadSignature.selector);
        hub.reportEquivocation(FEED, 1, a, b, payable(challenger));
    }

    // ---------------------------------------------------------------------------------------
    // Reports are judged by the state at post time
    // ---------------------------------------------------------------------------------------

    function _rotateKey(address who) internal returns (bytes memory newKey) {
        newKey = abi.encodePacked("rotated-", who);
        keyStatus.setKey(who, true, ALG, newKey);
    }

    function _signWith(bytes memory pubkey, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(pubkey, message)));
    }

    function test_StakePinsTheReportersKey() public view {
        address r = reporterList[0];
        assertEq(hub.reporterKeys(r), _pubkey(r));
        (,, uint64 activeSince, uint64 slashedAt) = hub.reporters(r);
        assertEq(activeSince, uint64(block.timestamp));
        assertEq(slashedAt, 0);
    }

    /// Regression: a reporter in an honest batch slashed itself for equivocation, which made it
    /// look inactive at the batch's post time and let it take half of the sequencer's bond.
    function test_SlashingAReporterLaterDoesNotMakeAnHonestBatchFraudulent() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        vm.warp(block.timestamp + 1);

        hub.reportEquivocation(FEED, 7, _report(7, 0, 100), _report(7, 0, 200), payable(challenger));
        assertFalse(hub.isActiveAt(reporterList[0], uint64(block.timestamp)));

        vm.expectRevert(AuguryHub.NoFraud.selector);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        assertEq(hub.sequencerBond(), MIN_BOND);
    }

    /// Regression: a reporter in an honest batch rotated its ML-DSA key on chain, so its report
    /// no longer verified against the current key and the honest sequencer could be slashed.
    function test_RotatingAKeyLaterDoesNotMakeAnHonestBatchFraudulent() public {
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        _rotateKey(reporterList[0]);

        vm.expectRevert(AuguryHub.NoFraud.selector);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        assertEq(hub.sequencerBond(), MIN_BOND);
    }

    function test_ReportSignedWithARotatedKeyIsFraud() public {
        address r = reporterList[0];
        bytes memory newKey = _rotateKey(r);
        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        rs[0].signature = _signWith(
            newKey, hub.reportMessage(FEED, 1, r, rs[0].price, rs[0].observedAt, rs[0].salt)
        );
        _post(1, rs, 101);
        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        (,,,,, AuguryHub.Status status) = hub.batches(FEED, 1);
        assertEq(uint8(status), uint8(AuguryHub.Status.Invalid));
    }

    function test_EquivocationEvidenceSurvivesKeyRotation() public {
        AuguryHub.SignedReport memory a = _report(1, 0, 100);
        AuguryHub.SignedReport memory b = _report(1, 0, 200);
        _rotateKey(reporterList[0]);
        hub.reportEquivocation(FEED, 1, a, b, payable(challenger));
        (uint256 left,,,) = hub.reporters(reporterList[0]);
        assertEq(left, 0);
    }

    function test_SlashedReporterCannotStakeAgain() public {
        address r = reporterList[0];
        hub.reportEquivocation(FEED, 1, _report(1, 0, 100), _report(1, 0, 200), payable(challenger));
        vm.prank(r);
        vm.expectRevert(AuguryHub.ReporterBanned.selector);
        hub.stake{value: MIN_STAKE}(r);
    }

    function test_TopUpAfterPostDoesNotHideAnUnderstakedReporter() public {
        address late = makeAddr("late");
        _registerKey(late);
        vm.deal(late, 10 ether);
        vm.prank(late);
        hub.stake{value: MIN_STAKE / 2}(late);
        reporterList[0] = late;

        AuguryHub.SignedReport[] memory rs = _reports(1, _prices3(100, 102, 101));
        _post(1, rs, 101);
        vm.warp(block.timestamp + 1);
        vm.prank(late);
        hub.stake{value: MIN_STAKE}(late);

        hub.challengeBatch(FEED, 1, rs, payable(challenger));
        (,,,,, AuguryHub.Status status) = hub.batches(FEED, 1);
        assertEq(uint8(status), uint8(AuguryHub.Status.Invalid));
    }

    function test_StakingAgainAfterWithdrawPinsTheNewKey() public {
        address r = reporterList[0];
        address payable to = payable(makeAddr("payout"));
        hub.requestExit(r, _sign(r, hub.exitMessage(hub.REPORTER_EXIT_TAG(), r, 0)));
        vm.warp(block.timestamp + EXIT_DELAY);
        hub.withdrawStake(r, to, _sign(r, hub.withdrawMessage(hub.REPORTER_WITHDRAW_TAG(), r, to, 1)));

        bytes memory newKey = _rotateKey(r);
        vm.prank(r);
        hub.stake{value: MIN_STAKE}(r);
        assertEq(hub.reporterKeys(r), newKey);
        (,, uint64 activeSince,) = hub.reporters(r);
        assertEq(activeSince, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------------------------
    // Median
    // ---------------------------------------------------------------------------------------

    function test_Median() public view {
        assertEq(hub.median(_prices3(5, 1, 3)), 3);
        int256[] memory even = new int256[](4);
        (even[0], even[1], even[2], even[3]) = (4, 1, 3, 2);
        assertEq(hub.median(even), 2);
        int256[] memory neg = new int256[](2);
        (neg[0], neg[1]) = (-3, 0);
        assertEq(hub.median(neg), -1);
    }

    /// Regression: the mean of two large middle values overflowed, so `challengeBatch` reverted
    /// and a batch with such reports could not be proven wrong.
    function test_MedianDoesNotOverflow() public view {
        int256 max = type(int256).max;
        int256 min = type(int256).min;
        int256[] memory two = new int256[](2);
        (two[0], two[1]) = (max, max);
        assertEq(hub.median(two), max);
        (two[0], two[1]) = (max, max - 1);
        assertEq(hub.median(two), max - 1);
        (two[0], two[1]) = (min, min);
        assertEq(hub.median(two), min);
        (two[0], two[1]) = (min, min + 1);
        assertEq(hub.median(two), min + 1);
        (two[0], two[1]) = (min, max);
        assertEq(hub.median(two), 0);
    }

    function testFuzz_MeanMatchesTruncatedDivision(int128 a, int128 b) public view {
        int256[] memory two = new int256[](2);
        (two[0], two[1]) = (int256(a), int256(b));
        assertEq(hub.median(two), (int256(a) + int256(b)) / 2);
    }

    function testFuzz_MedianIsBetweenMinAndMax(int128 a, int128 b, int128 c) public view {
        int256 m = hub.median(_prices3(a, b, c));
        int256 lo = a < b ? (a < c ? a : c) : (b < c ? b : c);
        int256 hi = a > b ? (a > c ? a : c) : (b > c ? b : c);
        assertGe(m, lo);
        assertLe(m, hi);
    }
}
