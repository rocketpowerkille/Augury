// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAugury} from "./interfaces/IAugury.sol";
import {QorePQC} from "./libraries/QorePQC.sol";

/// @title AuguryHub
/// @notice Settlement contract of the Augury post-quantum oracle rollup.
///
/// Reporters sign prices with ML-DSA-87 and seal them to a per-round key. The sequencer
/// decrypts each round, takes the median of the valid reports and posts it here as a batch
/// signed with ML-DSA-87. Anyone can prove a batch wrong in one step by submitting the
/// batch's signed reports: the hub rebuilds the report root, re-checks every report and
/// recomputes the median. A proven fraud slashes the sequencer's bond.
///
/// Nothing that moves trust is authorized by `msg.sender`. Batches, exits and withdrawals are
/// authorized by ML-DSA-87 signatures checked with the pqcVerify precompile, against keys
/// read from the chain with pqcKeyStatus. Depositing stake or bond is the only payable entry
/// point that uses `msg.sender`, and it only adds funds.
contract AuguryHub is IAugury {
    // ---------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------

    enum Status {
        None,
        Posted,
        Invalid
    }

    struct Batch {
        int256 price;
        bytes32 reportRoot;
        uint32 reportCount;
        uint64 postedAt;
        uint64 prevRound;
        Status status;
    }

    struct SignedReport {
        address reporter;
        int256 price;
        uint64 observedAt;
        bytes signature;
    }

    struct Staker {
        uint256 stake;
        uint64 exitRequestedAt;
    }

    // ---------------------------------------------------------------------------------------
    // Constants and configuration
    // ---------------------------------------------------------------------------------------

    /// @notice Every price uses 8 decimals.
    uint8 public constant DECIMALS = 8;

    /// @notice How many rounds `getPrice` walks back past invalidated batches.
    uint256 public constant MAX_WALK_BACK = 32;

    bytes32 public constant REPORT_TAG = keccak256("AUGURY_REPORT_V1");
    bytes32 public constant BATCH_TAG = keccak256("AUGURY_BATCH_V1");
    bytes32 public constant REPORTER_EXIT_TAG = keccak256("AUGURY_REPORTER_EXIT_V1");
    bytes32 public constant REPORTER_WITHDRAW_TAG = keccak256("AUGURY_REPORTER_WITHDRAW_V1");
    bytes32 public constant BOND_EXIT_TAG = keccak256("AUGURY_BOND_EXIT_V1");
    bytes32 public constant BOND_WITHDRAW_TAG = keccak256("AUGURY_BOND_WITHDRAW_V1");

    /// @notice The account whose registered ML-DSA-87 key signs batches.
    address public immutable sequencer;
    /// @notice The algorithm id pqcKeyStatus reports for ML-DSA-87 keys.
    uint8 public immutable mldsaAlgorithmId;
    uint256 public immutable minReporterStake;
    uint256 public immutable minSequencerBond;
    /// @notice Seconds during which a batch can be proven wrong.
    uint64 public immutable challengeWindow;
    /// @notice Seconds between an exit request and the withdrawal it allows.
    uint64 public immutable exitDelay;
    uint32 public immutable minReports;
    uint32 public immutable maxReports;

    // ---------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------

    mapping(bytes32 feedId => mapping(uint64 round => Batch)) public batches;
    mapping(bytes32 feedId => uint64) public latestRound;
    mapping(address reporter => Staker) public reporters;
    /// @notice Per-account nonce for signed exits and withdrawals.
    mapping(address account => uint64) public nonces;

    uint256 public sequencerBond;
    uint64 public bondExitRequestedAt;
    /// @notice Slashed funds not paid to challengers. They stay locked in the hub.
    uint256 public slashedTotal;

    // ---------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------

    event Staked(address indexed reporter, uint256 amount, uint256 total);
    event ExitRequested(address indexed account, uint64 at);
    event StakeWithdrawn(address indexed reporter, address to, uint256 amount);
    event SequencerBonded(uint256 amount, uint256 total);
    event BondWithdrawn(address to, uint256 amount);
    event BatchPosted(
        bytes32 indexed feedId,
        uint64 indexed round,
        int256 price,
        bytes32 reportRoot,
        uint32 reportCount
    );
    event BatchInvalidated(
        bytes32 indexed feedId, uint64 indexed round, FraudKind kind, address challenger
    );
    event SequencerSlashed(uint256 amount, address challenger, uint256 reward);
    event ReporterSlashed(address indexed reporter, uint256 amount, address challenger);

    enum FraudKind {
        WrongMedian,
        BadSignature,
        InactiveReporter,
        DuplicateReporter
    }

    // ---------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------

    error KeyNotRegistered(address account);
    error BadSignature();
    error ZeroAmount();
    error ExitPending();
    error NoExitRequested();
    error ExitNotReady();
    error NothingStaked();
    error BondTooLow();
    error RoundNotIncreasing();
    error ReportCountOutOfRange();
    error NonPositivePrice();
    error BatchNotChallengeable();
    error ReportCountMismatch();
    error RootMismatch();
    error NoFraud();
    error NotEquivocation();
    error NoPrice();
    error TransferFailed();
    error InvalidConfig();

    // ---------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------

    constructor(
        address sequencer_,
        uint8 mldsaAlgorithmId_,
        uint256 minReporterStake_,
        uint256 minSequencerBond_,
        uint64 challengeWindow_,
        uint64 exitDelay_,
        uint32 minReports_,
        uint32 maxReports_
    ) {
        if (
            sequencer_ == address(0) || minReporterStake_ == 0 || minSequencerBond_ == 0
                || challengeWindow_ == 0 || exitDelay_ < challengeWindow_ || minReports_ == 0
                || maxReports_ < minReports_
        ) revert InvalidConfig();
        sequencer = sequencer_;
        mldsaAlgorithmId = mldsaAlgorithmId_;
        minReporterStake = minReporterStake_;
        minSequencerBond = minSequencerBond_;
        challengeWindow = challengeWindow_;
        exitDelay = exitDelay_;
        minReports = minReports_;
        maxReports = maxReports_;
    }

    // ---------------------------------------------------------------------------------------
    // Signed messages (every field is a static ABI type, so each message is 32-byte words)
    // ---------------------------------------------------------------------------------------

    function reportMessage(
        bytes32 feedId,
        uint64 round,
        address reporter,
        int256 price,
        uint64 observedAt
    ) public view returns (bytes memory) {
        return abi.encode(
            REPORT_TAG, block.chainid, address(this), feedId, round, reporter, price, observedAt
        );
    }

    function batchMessage(
        bytes32 feedId,
        uint64 round,
        int256 price,
        bytes32 reportRoot,
        uint32 reportCount
    ) public view returns (bytes memory) {
        return abi.encode(
            BATCH_TAG, block.chainid, address(this), feedId, round, price, reportRoot, reportCount
        );
    }

    function exitMessage(bytes32 tag, address account, uint64 nonce)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(tag, block.chainid, address(this), account, nonce);
    }

    function withdrawMessage(bytes32 tag, address account, address to, uint64 nonce)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(tag, block.chainid, address(this), account, to, nonce);
    }

    /// @notice Leaf of the report root: SHA-256 of the report's signed message.
    function reportLeaf(bytes32 feedId, uint64 round, SignedReport calldata r)
        public
        view
        returns (bytes32)
    {
        return sha256(reportMessage(feedId, round, r.reporter, r.price, r.observedAt));
    }

    // ---------------------------------------------------------------------------------------
    // Reporter stake
    // ---------------------------------------------------------------------------------------

    /// @notice Add stake for `msg.sender`, which must have an ML-DSA-87 key registered.
    function stake() external payable {
        if (msg.value == 0) revert ZeroAmount();
        _requireKey(msg.sender);
        Staker storage s = reporters[msg.sender];
        if (s.exitRequestedAt != 0) revert ExitPending();
        s.stake += msg.value;
        emit Staked(msg.sender, msg.value, s.stake);
    }

    /// @notice Start leaving. The reporter stops counting as active for batches posted after now.
    function requestExit(address reporter, bytes calldata signature) external {
        Staker storage s = reporters[reporter];
        if (s.stake == 0) revert NothingStaked();
        if (s.exitRequestedAt != 0) revert ExitPending();
        _consumeSigned(reporter, exitMessage(REPORTER_EXIT_TAG, reporter, nonces[reporter]), signature);
        s.exitRequestedAt = uint64(block.timestamp);
        emit ExitRequested(reporter, uint64(block.timestamp));
    }

    /// @notice Withdraw the whole stake to `to`, once the exit delay has passed.
    function withdrawStake(address reporter, address payable to, bytes calldata signature)
        external
    {
        Staker storage s = reporters[reporter];
        if (s.exitRequestedAt == 0) revert NoExitRequested();
        if (block.timestamp < uint256(s.exitRequestedAt) + exitDelay) revert ExitNotReady();
        _consumeSigned(
            reporter,
            withdrawMessage(REPORTER_WITHDRAW_TAG, reporter, to, nonces[reporter]),
            signature
        );
        uint256 amount = s.stake;
        s.stake = 0;
        s.exitRequestedAt = 0;
        emit StakeWithdrawn(reporter, to, amount);
        _send(to, amount);
    }

    /// @notice True if `reporter` counted as active for a batch posted at `at`.
    function isActiveAt(address reporter, uint64 at) public view returns (bool) {
        Staker storage s = reporters[reporter];
        return s.stake >= minReporterStake && (s.exitRequestedAt == 0 || s.exitRequestedAt > at);
    }

    // ---------------------------------------------------------------------------------------
    // Sequencer bond
    // ---------------------------------------------------------------------------------------

    /// @notice Add to the sequencer's bond. Anyone may fund it.
    function bondSequencer() external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (bondExitRequestedAt != 0) revert ExitPending();
        sequencerBond += msg.value;
        emit SequencerBonded(msg.value, sequencerBond);
    }

    function requestBondExit(bytes calldata signature) external {
        if (sequencerBond == 0) revert NothingStaked();
        if (bondExitRequestedAt != 0) revert ExitPending();
        _consumeSigned(sequencer, exitMessage(BOND_EXIT_TAG, sequencer, nonces[sequencer]), signature);
        bondExitRequestedAt = uint64(block.timestamp);
        emit ExitRequested(sequencer, uint64(block.timestamp));
    }

    function withdrawBond(address payable to, bytes calldata signature) external {
        if (bondExitRequestedAt == 0) revert NoExitRequested();
        if (block.timestamp < uint256(bondExitRequestedAt) + exitDelay) revert ExitNotReady();
        _consumeSigned(
            sequencer, withdrawMessage(BOND_WITHDRAW_TAG, sequencer, to, nonces[sequencer]), signature
        );
        uint256 amount = sequencerBond;
        sequencerBond = 0;
        bondExitRequestedAt = 0;
        emit BondWithdrawn(to, amount);
        _send(to, amount);
    }

    // ---------------------------------------------------------------------------------------
    // Batches
    // ---------------------------------------------------------------------------------------

    /// @notice Post the median of a round, signed by the sequencer's ML-DSA-87 key. Anyone may
    /// relay it.
    /// @dev The batch's signed reports are part of the call, and the hub derives the report
    /// root from them. Every batch's reports are therefore public in the transaction data, so
    /// any watchtower can rebuild them for `challengeBatch`. Signatures are not checked here,
    /// to keep posting cheap; a bad one is caught by the fraud proof.
    function postBatch(
        bytes32 feedId,
        uint64 round,
        int256 price,
        SignedReport[] calldata reports,
        bytes calldata signature
    ) external {
        if (sequencerBond < minSequencerBond || bondExitRequestedAt != 0) revert BondTooLow();
        if (round <= latestRound[feedId]) revert RoundNotIncreasing();
        if (reports.length < minReports || reports.length > maxReports) {
            revert ReportCountOutOfRange();
        }
        if (price <= 0) revert NonPositivePrice();
        uint32 reportCount = uint32(reports.length);
        bytes32 reportRoot = _reportRoot(feedId, round, reports);
        if (!_verifyBy(sequencer, batchMessage(feedId, round, price, reportRoot, reportCount), signature))
        {
            revert BadSignature();
        }

        batches[feedId][round] = Batch({
            price: price,
            reportRoot: reportRoot,
            reportCount: reportCount,
            postedAt: uint64(block.timestamp),
            prevRound: latestRound[feedId],
            status: Status.Posted
        });
        latestRound[feedId] = round;
        emit BatchPosted(feedId, round, price, reportRoot, reportCount);
    }

    /// @notice One-step fraud proof. `reports` must be exactly the batch's reports, in order.
    /// The batch is invalidated and the sequencer slashed if any report is invalid or the
    /// median differs from the posted price. Reverts with `NoFraud` otherwise.
    function challengeBatch(bytes32 feedId, uint64 round, SignedReport[] calldata reports)
        external
    {
        Batch storage b = batches[feedId][round];
        if (b.status != Status.Posted || block.timestamp >= uint256(b.postedAt) + challengeWindow)
        {
            revert BatchNotChallengeable();
        }
        if (reports.length != b.reportCount) revert ReportCountMismatch();
        if (_reportRoot(feedId, round, reports) != b.reportRoot) revert RootMismatch();

        (bool fraud, FraudKind kind) = _findFraud(feedId, round, b, reports);
        if (!fraud) revert NoFraud();

        b.status = Status.Invalid;
        emit BatchInvalidated(feedId, round, kind, msg.sender);
        _slashSequencer(payable(msg.sender));
    }

    /// @notice Slash a reporter that signed two different reports for the same round.
    function reportEquivocation(
        bytes32 feedId,
        uint64 round,
        SignedReport calldata a,
        SignedReport calldata b
    ) external {
        if (a.reporter != b.reporter) revert NotEquivocation();
        if (a.price == b.price && a.observedAt == b.observedAt) revert NotEquivocation();
        address reporter = a.reporter;
        if (!_verifyBy(reporter, reportMessage(feedId, round, reporter, a.price, a.observedAt), a.signature))
        {
            revert BadSignature();
        }
        if (!_verifyBy(reporter, reportMessage(feedId, round, reporter, b.price, b.observedAt), b.signature))
        {
            revert BadSignature();
        }

        Staker storage s = reporters[reporter];
        uint256 amount = s.stake;
        if (amount == 0) revert NothingStaked();
        s.stake = 0;
        uint256 reward = amount / 2;
        slashedTotal += amount - reward;
        emit ReporterSlashed(reporter, amount, msg.sender);
        _send(payable(msg.sender), reward);
    }

    // ---------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------

    function getPrice(bytes32 feedId)
        external
        view
        returns (int256 price, uint8 decimals, uint64 round, uint64 settledAt)
    {
        return _walkBack(feedId, false);
    }

    function getFinalPrice(bytes32 feedId)
        external
        view
        returns (int256 price, uint8 decimals, uint64 round, uint64 settledAt)
    {
        return _walkBack(feedId, true);
    }

    function isFinal(bytes32 feedId, uint64 round) public view returns (bool) {
        Batch storage b = batches[feedId][round];
        return b.status == Status.Posted && block.timestamp >= uint256(b.postedAt) + challengeWindow;
    }

    /// @notice Median used by the sequencer and the fraud proof. For an even count it is the
    /// mean of the two middle values, rounded toward zero.
    function median(int256[] memory values) public pure returns (int256) {
        uint256 n = values.length;
        for (uint256 i = 1; i < n; i++) {
            int256 v = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > v) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = v;
        }
        if (n % 2 == 1) return values[n / 2];
        return (values[n / 2 - 1] + values[n / 2]) / 2;
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    /// @dev SHA-256 of the concatenated report leaves, in order.
    function _reportRoot(bytes32 feedId, uint64 round, SignedReport[] calldata reports)
        internal
        view
        returns (bytes32)
    {
        bytes memory leaves = new bytes(32 * reports.length);
        for (uint256 i = 0; i < reports.length; i++) {
            bytes32 leaf = reportLeaf(feedId, round, reports[i]);
            assembly ("memory-safe") {
                mstore(add(add(leaves, 32), mul(i, 32)), leaf)
            }
        }
        return sha256(leaves);
    }

    function _findFraud(
        bytes32 feedId,
        uint64 round,
        Batch storage b,
        SignedReport[] calldata reports
    ) internal view returns (bool, FraudKind) {
        int256[] memory prices = new int256[](reports.length);
        for (uint256 i = 0; i < reports.length; i++) {
            SignedReport calldata r = reports[i];
            for (uint256 j = 0; j < i; j++) {
                if (reports[j].reporter == r.reporter) return (true, FraudKind.DuplicateReporter);
            }
            if (!isActiveAt(r.reporter, b.postedAt)) return (true, FraudKind.InactiveReporter);
            if (!_verifyBy(
                    r.reporter,
                    reportMessage(feedId, round, r.reporter, r.price, r.observedAt),
                    r.signature
                )) return (true, FraudKind.BadSignature);
            prices[i] = r.price;
        }
        if (median(prices) != b.price) return (true, FraudKind.WrongMedian);
        return (false, FraudKind.WrongMedian);
    }

    function _walkBack(bytes32 feedId, bool finalOnly)
        internal
        view
        returns (int256, uint8, uint64, uint64)
    {
        uint64 round = latestRound[feedId];
        for (uint256 i = 0; i < MAX_WALK_BACK && round != 0; i++) {
            Batch storage b = batches[feedId][round];
            bool usable = b.status == Status.Posted && (!finalOnly || isFinal(feedId, round));
            if (usable) return (b.price, DECIMALS, round, b.postedAt);
            round = b.prevRound;
        }
        revert NoPrice();
    }

    function _slashSequencer(address payable challenger) internal {
        uint256 amount = sequencerBond;
        sequencerBond = 0;
        uint256 reward = amount / 2;
        slashedTotal += amount - reward;
        emit SequencerSlashed(amount, challenger, reward);
        _send(challenger, reward);
    }

    /// @dev Verify `signature` by `account` over `message`, then advance the account's nonce.
    function _consumeSigned(address account, bytes memory message, bytes calldata signature)
        internal
    {
        if (!_verifyBy(account, message, signature)) revert BadSignature();
        nonces[account]++;
    }

    function _verifyBy(address account, bytes memory message, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        (bool registered, uint8 algorithmId, bytes memory pubkey) = QorePQC.keyStatus(account);
        if (!registered || algorithmId != mldsaAlgorithmId) return false;
        return QorePQC.verify(pubkey, signature, message);
    }

    function _requireKey(address account) internal view {
        (bool registered, uint8 algorithmId,) = QorePQC.keyStatus(account);
        if (!registered || algorithmId != mldsaAlgorithmId) revert KeyNotRegistered(account);
    }

    function _send(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
