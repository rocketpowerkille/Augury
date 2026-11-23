// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice What a consumer contract needs to read Augury prices.
interface IAugury {
    /// @notice Latest price for `feedId` that has not been proven wrong. It may still be inside
    /// its challenge window; use `getFinalPrice` when that matters.
    function getPrice(bytes32 feedId)
        external
        view
        returns (int256 price, uint8 decimals, uint64 round, uint64 settledAt);

    /// @notice Latest price for `feedId` whose challenge window has passed without a fraud proof.
    function getFinalPrice(bytes32 feedId)
        external
        view
        returns (int256 price, uint8 decimals, uint64 round, uint64 settledAt);
}
